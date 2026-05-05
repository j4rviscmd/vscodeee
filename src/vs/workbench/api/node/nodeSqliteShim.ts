/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `node:sqlite` polyfill that wraps `bun:sqlite` to provide compatibility
 * for extensions that depend on the Node.js 22+ built-in SQLite module.
 *
 * Unsupported methods throw explicit errors indicating that the functionality
 * is not available through `bun:sqlite`.
 */

import nodeModule from 'node:module';

const nodeRequire = nodeModule.createRequire(import.meta.url);

// Use require() to import bun:sqlite since TypeScript cannot resolve its types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bunSqlite = nodeRequire('bun:sqlite') as { Database: new (...args: unknown[]) => unknown; Statement: new (...args: unknown[]) => unknown };
type BunDatabase = InstanceType<typeof bunSqlite.Database>;
type BunStatement = InstanceType<typeof bunSqlite.Statement>;

/** Supported value types that can be bound as SQL parameters. */
type SQLInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

/** Value types that SQLite can return from a query. */
type SQLOutputValue = null | number | bigint | string | Uint8Array;

// --- Error helper for unsupported features ---

/**
 * Throws an error indicating that a `node:sqlite` method is not supported.
 *
 * @param method - The name of the unsupported method.
 * @throws {Error} Always throws with a descriptive message.
 */
function notSupported(method: string): never {
	throw new Error(`[node:sqlite shim] ${method}() is not supported in this environment (bun:sqlite does not provide this functionality)`);
}

// --- Parameter adaptation ---

/**
 * Type guard that determines whether a value is a named parameter object.
 *
 * `node:sqlite` uses `stmt.all(namedParams?, ...anonParams)` where the first
 * argument is conditionally an object for named parameters. This guard
 * distinguishes named parameter objects from positional values.
 *
 * @param value - The value to test.
 * @returns `true` if the value is a plain object suitable for named parameters.
 */
function isNamedParamObject(value: unknown): value is Record<string, SQLInputValue> {
	return value !== null
		&& typeof value === 'object'
		&& !(value instanceof ArrayBuffer)
		&& !ArrayBuffer.isView(value)
		&& !Array.isArray(value);
}

/**
 * Ensures a named parameter key has a recognized prefix.
 *
 * `bun:sqlite` requires named parameters to use `$`, `:`, or `@` prefixes.
 * If the key already has one of these prefixes it is returned unchanged;
 * otherwise `$` is prepended.
 *
 * @param key - The named parameter key.
 * @returns The key with a guaranteed `$`, `:`, or `@` prefix.
 */
function ensureKeyPrefix(key: string): string {
	if (key.startsWith('$') || key.startsWith(':') || key.startsWith('@')) {
		return key;
	}
	return '$' + key;
}

/**
 * Adapts `node:sqlite` style parameters to `bun:sqlite` format.
 *
 * When the first argument is a named parameter object, its keys are
 * normalized with `ensureKeyPrefix` and returned as a record.
 * Otherwise all arguments are treated as positional parameters and
 * returned as an array.
 *
 * @param named - The first argument, which may be a named parameter object or a positional value.
 * @param anon - Additional positional parameter values.
 * @returns Either a named parameter record or a positional parameter array.
 */
function adaptParams(named: unknown, ...anon: SQLInputValue[]): SQLInputValue[] | Record<string, SQLInputValue> {
	if (isNamedParamObject(named)) {
		const result: Record<string, SQLInputValue> = {};
		for (const key of Object.keys(named)) {
			result[ensureKeyPrefix(key)] = named[key];
		}
		return result;
	}

	// Positional parameters
	const args: SQLInputValue[] = [];
	if (named !== undefined) {
		args.push(named as SQLInputValue);
	}
	args.push(...anon);
	return args;
}

// --- SQLite constants ---

const SQLITE_CHANGESET_DATA = 1;
const SQLITE_CHANGESET_NOTFOUND = 2;
const SQLITE_CHANGESET_CONFLICT = 3;
const SQLITE_CHANGESET_FOREIGN_KEY = 4;
const SQLITE_CHANGESET_OMIT = 0;
const SQLITE_CHANGESET_REPLACE = 1;
const SQLITE_CHANGESET_ABORT = 2;

// --- StatementSync ---

/** Metadata describing a column in a prepared statement result set. */
interface StatementColumnMetadata {
	/** The column name, or `null` if unavailable. */
	column: string | null;
	/** The database name, or `null` if unavailable. */
	database: string | null;
	/** The column name. */
	name: string;
	/** The table name, or `null` if unavailable. */
	table: string | null;
	/** The column type affinity, or `null` if unavailable. */
	type: string | null;
}

/** Result information returned by a write operation (`run`). */
interface StatementResultingChanges {
	/** The number of rows affected by the statement. */
	changes: number | bigint;
	/** The ROWID of the most recently inserted row. */
	lastInsertRowid: number | bigint;
}

/** Resolved params from StatementSync overloads. */
type ResolvedParams = SQLInputValue[] | Record<string, SQLInputValue>;

/**
 * Synchronous prepared statement wrapper that provides `node:sqlite`-compatible
 * parameter binding semantics over a `bun:sqlite` statement.
 *
 * Supports both named parameters (as a single object argument) and positional
 * parameters (as rest arguments), matching the `node:sqlite` overload pattern.
 */
export class StatementSync {
	private readonly _stmt: BunStatement;
	private readonly _sourceSQL: string;
	private _readBigInts: boolean;

	constructor(stmt: BunStatement, sourceSQL: string) {
		this._stmt = stmt;
		this._sourceSQL = sourceSQL;
		this._readBigInts = false;
	}

	/**
	 * Resolves the variadic arguments of a statement method call into
	 * either a named parameter record or a positional parameter array.
	 *
	 * @param args - The raw arguments passed to the statement method.
	 * @returns The resolved parameters in the format expected by `bun:sqlite`.
	 */
	private _resolveParams(args: (SQLInputValue | Record<string, SQLInputValue>)[]): ResolvedParams {
		return adaptParams(
			args[0] as SQLInputValue | Record<string, SQLInputValue> | undefined,
			...(args.slice(1) as SQLInputValue[])
		);
	}

	/**
	 * Invokes the underlying `bun:sqlite` statement method with the resolved
	 * parameters, dispatching to the correct overload based on whether the
	 * parameters are positional (array) or named (record).
	 *
	 * @param method - The `bun:sqlite` method name to invoke (`all`, `get`, or `iterate`).
	 * @param params - The resolved parameters from `_resolveParams`.
	 * @returns The result of the underlying method call.
	 */
	private _callWithParams<T>(method: 'all' | 'get' | 'iterate', params: ResolvedParams): T {
		if (Array.isArray(params)) {
			return (this._stmt[method] as (...p: SQLInputValue[]) => T)(...params);
		}
		return (this._stmt[method] as (p: Record<string, SQLInputValue>) => T)(params);
	}

	/**
	 * Executes the statement and returns all matching rows.
	 *
	 * @overload
	 * @param anonymousParameters - Positional parameter values.
	 * @returns An array of row objects.
	 *
	 * @overload
	 * @param namedParameters - Named parameter key-value pairs.
	 * @param anonymousParameters - Additional positional parameter values.
	 * @returns An array of row objects.
	 */
	all(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
	all(namedParameters: Record<string, SQLInputValue>, ...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue>[];
	all(...args: (SQLInputValue | Record<string, SQLInputValue>)[]): Record<string, SQLOutputValue>[] {
		return this._callWithParams<Record<string, SQLOutputValue>[]>('all', this._resolveParams(args));
	}

	/**
	 * Executes the statement and returns the first matching row.
	 *
	 * @overload
	 * @param anonymousParameters - Positional parameter values.
	 * @returns The first row object, or `undefined` if no rows match.
	 *
	 * @overload
	 * @param namedParameters - Named parameter key-value pairs.
	 * @param anonymousParameters - Additional positional parameter values.
	 * @returns The first row object, or `undefined` if no rows match.
	 */
	get(...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
	get(namedParameters: Record<string, SQLInputValue>, ...anonymousParameters: SQLInputValue[]): Record<string, SQLOutputValue> | undefined;
	get(...args: (SQLInputValue | Record<string, SQLInputValue>)[]): Record<string, SQLOutputValue> | undefined {
		return this._callWithParams<Record<string, SQLOutputValue> | undefined>('get', this._resolveParams(args));
	}

	/**
	 * Executes the statement as a write operation and returns the
	 * resulting change information.
	 *
	 * When `setReadBigInts(true)` has been called, `changes` and
	 * `lastInsertRowid` are returned as `bigint`; otherwise they are
	 * returned as `number`.
	 *
	 * @overload
	 * @param anonymousParameters - Positional parameter values.
	 * @returns The number of affected rows and the last inserted ROWID.
	 *
	 * @overload
	 * @param namedParameters - Named parameter key-value pairs.
	 * @param anonymousParameters - Additional positional parameter values.
	 * @returns The number of affected rows and the last inserted ROWID.
	 */
	run(...anonymousParameters: SQLInputValue[]): StatementResultingChanges;
	run(namedParameters: Record<string, SQLInputValue>, ...anonymousParameters: SQLInputValue[]): StatementResultingChanges;
	run(...args: (SQLInputValue | Record<string, SQLInputValue>)[]): StatementResultingChanges {
		const params = this._resolveParams(args);
		const result = Array.isArray(params)
			? this._stmt.run(...params)
			: this._stmt.run(params);
		return {
			changes: this._readBigInts ? BigInt(result.changes) : result.changes,
			lastInsertRowid: this._readBigInts ? BigInt(result.lastInsertRowid) : result.lastInsertRowid,
		};
	}

	/**
	 * Executes the statement and returns an iterator over the matching rows.
	 *
	 * @overload
	 * @param anonymousParameters - Positional parameter values.
	 * @returns An iterable iterator of row objects.
	 *
	 * @overload
	 * @param namedParameters - Named parameter key-value pairs.
	 * @param anonymousParameters - Additional positional parameter values.
	 * @returns An iterable iterator of row objects.
	 */
	iterate(...anonymousParameters: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
	iterate(namedParameters: Record<string, SQLInputValue>, ...anonymousParameters: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>;
	iterate(...args: (SQLInputValue | Record<string, SQLInputValue>)[]): IterableIterator<Record<string, SQLOutputValue>> {
		return this._callWithParams<IterableIterator<Record<string, SQLOutputValue>>>('iterate', this._resolveParams(args));
	}

	/**
	 * Returns metadata for each column in the statement's result set.
	 *
	 * Note: `bun:sqlite` only exposes column names. All other metadata
	 * fields (`column`, `database`, `table`, `type`) are returned as `null`.
	 *
	 * @returns An array of column metadata objects.
	 */
	columns(): StatementColumnMetadata[] {
		const names = (this._stmt as unknown as { columnNames: string[] }).columnNames;
		return names.map(name => ({
			column: null,
			database: null,
			name,
			table: null,
			type: null,
		}));
	}

	/** The original SQL source string used to create this statement. */
	get sourceSQL(): string {
		return this._sourceSQL;
	}

	/** The expanded SQL string with bound parameters substituted. */
	get expandedSQL(): string {
		return this._stmt.toString();
	}

	/**
	 * Enables or disables bare named parameters (without `$`, `:`, or `@` prefix).
	 *
	 * This is a no-op in this shim; `bun:sqlite` handles bare names through
	 * its own `strict` option on database construction.
	 *
	 * @param _enabled - Whether bare named parameters should be allowed.
	 */
	setAllowBareNamedParameters(_enabled: boolean): void {
		// Stored for compatibility; bun:sqlite handles bare names via strict option
	}

	/**
	 * Enables or disables unknown named parameters.
	 *
	 * This is a no-op in this shim; `bun:sqlite` silently ignores
	 * unknown parameters.
	 *
	 * @param _enabled - Whether unknown named parameters should be allowed.
	 */
	setAllowUnknownNamedParameters(_enabled: boolean): void {
		// Stored for compatibility; bun:sqlite silently ignores unknown params
	}

	/**
	 * Controls whether integer values are returned as `bigint` instead of `number`.
	 *
	 * When enabled, the `run()` method returns `changes` and `lastInsertRowid`
	 * as `bigint` values.
	 *
	 * @param enabled - `true` to return integers as `bigint`, `false` for `number`.
	 */
	setReadBigInts(enabled: boolean): void {
		this._readBigInts = enabled;
	}
}

// --- DatabaseSync ---

/** Configuration options for opening a SQLite database. */
interface DatabaseSyncOptions {
	/** If `false`, the database is not opened immediately (default: `true`). */
	open?: boolean;
	/** Opens the database in read-only mode (default: `false`). */
	readOnly?: boolean;
	/** Enables foreign key constraint enforcement (default: `true`). */
	enableForeignKeyConstraints?: boolean;
	/** Enables double-quoted string literals (default: `false`). */
	enableDoubleQuotedStringLiterals?: boolean;
	/** Allows loading native SQLite extensions (default: `false`). */
	allowExtension?: boolean;
	/** Busy timeout in milliseconds for lock contention (default: `0`). */
	timeout?: number;
	/** Returns integer values as `bigint` (default: `false`). */
	readBigInts?: boolean;
	/** Returns query rows as arrays instead of objects (default: `false`). Not supported in this shim. */
	returnArrays?: boolean;
	/** Allows named parameters without `$`, `:`, or `@` prefix (default: `false`). Not supported in this shim. */
	allowBareNamedParameters?: boolean;
	/** Allows unknown named parameters to be silently ignored (default: `false`). Not supported in this shim. */
	allowUnknownNamedParameters?: boolean;
}

/**
 * Synchronous SQLite database connection that provides `node:sqlite`-compatible
 * API over `bun:sqlite`.
 *
 * Supports deferred opening (via `open: false`), read-only mode, foreign key
 * enforcement, and PRAGMA configuration through constructor options.
 * Implements `Disposable` for use with `using` statements.
 */
export class DatabaseSync implements Disposable {
	private _db: BunDatabase | null;
	private readonly _path: string;
	private readonly _options: DatabaseSyncOptions;
	private _allowExtension: boolean;
	private _closed: boolean;

	/**
	 * Creates a new `DatabaseSync` instance.
	 *
	 * @param path - The database file path. Use `':memory:'` for an in-memory database.
	 * @param options - Optional configuration for the database connection.
	 */
	constructor(path: string | Buffer | URL, options?: DatabaseSyncOptions) {
		this._path = path instanceof URL ? path.pathname : path.toString();
		this._options = { ...options };
		this._allowExtension = options?.allowExtension ?? false;
		this._closed = false;

		if (options?.open === false) {
			this._db = null;
		} else {
			this._db = this._createDb();
		}
	}

	/**
	 * Creates the underlying `bun:sqlite` Database instance, applying
	 * the configured options and PRAGMA settings.
	 *
	 * @returns The newly created `bun:sqlite` Database.
	 */
	private _createDb(): BunDatabase {
		const opts: Record<string, unknown> = {};
		if (this._options.readOnly) {
			opts.readonly = true;
		}
		if (this._options.readBigInts) {
			opts.safeIntegers = true;
		}
		const db = new bunSqlite.Database(this._path, Object.keys(opts).length > 0 ? opts : undefined);

		if (this._options.enableForeignKeyConstraints !== false) {
			db.run('PRAGMA foreign_keys = ON');
		}
		if (this._options.enableDoubleQuotedStringLiterals) {
			db.run('PRAGMA double_quoted_strings = ON');
		}
		if (this._options.timeout && this._options.timeout > 0) {
			db.run(`PRAGMA busy_timeout = ${Number(this._options.timeout)}`);
		}
		return db;
	}

	/**
	 * Ensures the database connection is open and returns the underlying
	 * `bun:sqlite` Database instance.
	 *
	 * @returns The open `bun:sqlite` Database.
	 * @throws {Error} If the database is not open.
	 */
	private _ensureOpen(): BunDatabase {
		if (!this._db) {
			throw new Error('Database is not open');
		}
		return this._db;
	}

	/**
	 * Opens the database connection if it was created with `open: false`.
	 *
	 * @throws {Error} If the database is already open.
	 */
	open(): void {
		if (this._db) {
			throw new Error('Database is already open');
		}
		this._db = this._createDb();
		this._closed = false;
	}

	/** Closes the database connection. Safe to call multiple times. */
	close(): void {
		if (this._closed || !this._db) {
			return;
		}
		this._db.close();
		this._db = null;
		this._closed = true;
	}

	/**
	 * Creates a prepared statement from the given SQL string.
	 *
	 * @param sql - The SQL statement to prepare.
	 * @returns A `StatementSync` wrapping the prepared statement.
	 * @throws {Error} If the database is not open.
	 */
	prepare(sql: string): StatementSync {
		const stmt = this._ensureOpen().prepare(sql);
		return new StatementSync(stmt, sql);
	}

	/**
	 * Loads a native SQLite extension from the given file path.
	 *
	 * Requires `allowExtension: true` to have been set in the constructor
	 * options or enabled via `enableLoadExtension`.
	 *
	 * @param path - The file path to the native extension.
	 * @throws {Error} If extension loading is not allowed or the database is not open.
	 */
	loadExtension(path: string): void {
		if (!this._allowExtension) {
			throw new Error('[node:sqlite shim] Extension loading is not allowed. Set allowExtension: true when constructing the database.');
		}
		this._ensureOpen().loadExtension(path);
	}

	/**
	 * Enables or disables the ability to load native SQLite extensions.
	 *
	 * @param allow - `true` to allow extension loading, `false` to disallow.
	 */
	enableLoadExtension(allow: boolean): void {
		this._allowExtension = allow;
	}

	/** Whether the database connection is currently open. */
	get isOpen(): boolean {
		return this._db !== null && !this._closed;
	}

	/**
	 * Whether the database is currently in a transaction.
	 *
	 * Not supported in this shim.
	 *
	 * @returns Never returns; always throws.
	 * @throws {Error} Always throws — `bun:sqlite` does not expose transaction state.
	 */
	get isTransaction(): boolean {
		return notSupported('isTransaction');
	}

	/**
	 * Returns the file path of the database, or `null` for in-memory databases.
	 *
	 * @param _dbName - The database name (unused; only the main database path is returned).
	 * @returns The database file path, or `null` for `:memory:` databases.
	 */
	location(_dbName?: string): string | null {
		if (this._path === ':memory:') {
			return null;
		}
		return this._path;
	}

	/**
	 * Registers a custom SQL function.
	 *
	 * Not supported in this shim.
	 *
	 * @param _name - The function name to register.
	 * @param _optionsOrFunc - The function implementation or options object.
	 * @param _func - The function implementation (when `_optionsOrFunc` is options).
	 * @throws {Error} Always throws — `bun:sqlite` does not support custom function registration via this API.
	 */
	function(_name: string, _optionsOrFunc: unknown, _func?: (...args: SQLOutputValue[]) => SQLInputValue): void {
		notSupported('function');
	}

	/**
	 * Registers a custom SQL aggregate function.
	 *
	 * Not supported in this shim.
	 *
	 * @param _name - The aggregate function name to register.
	 * @param _options - The aggregate function options.
	 * @throws {Error} Always throws — `bun:sqlite` does not support custom aggregate registration via this API.
	 */
	aggregate(_name: string, _options: unknown): void {
		notSupported('aggregate');
	}

	/**
	 * Creates a session for generating changesets.
	 *
	 * Not supported in this shim.
	 *
	 * @param _options - Session options (table filter, database name).
	 * @returns Never returns; always throws.
	 * @throws {Error} Always throws — `bun:sqlite` does not support sessions.
	 */
	createSession(_options?: { table?: string; db?: string }): { changeset(): Uint8Array; patchset(): Uint8Array; close(): void } {
		notSupported('createSession');
	}

	/**
	 * Applies a changeset to the database.
	 *
	 * Not supported in this shim.
	 *
	 * @param _changeset - The changeset data to apply.
	 * @param _options - Optional conflict resolution options.
	 * @returns Never returns; always throws.
	 * @throws {Error} Always throws — `bun:sqlite` does not support changeset application.
	 */
	applyChangeset(_changeset: Uint8Array, _options?: unknown): boolean {
		notSupported('applyChangeset');
	}

	/** Disposes of the database by closing the connection. */
	[Symbol.dispose](): void {
		this.close();
	}
}

// --- backup function ---

/**
 * Creates an online backup of a SQLite database.
 *
 * Not supported in this shim.
 *
 * @param _sourceDb - The source database to back up.
 * @param _path - The destination file path for the backup.
 * @param _options - Optional backup configuration.
 * @returns Never resolves; always throws.
 * @throws {Error} Always throws — `bun:sqlite` does not support online backup.
 */
export function backup(_sourceDb: DatabaseSync, _path: string | Buffer | URL, _options?: unknown): Promise<void> {
	notSupported('backup');
}

// --- constants ---

/**
 * SQLite constants exposed by the `node:sqlite` module.
 *
 * These values correspond to the SQLite session changeset conflict
 * resolution codes used with `createSession` and `applyChangeset`.
 */
export const constants = {
	SQLITE_CHANGESET_DATA,
	SQLITE_CHANGESET_NOTFOUND,
	SQLITE_CHANGESET_CONFLICT,
	SQLITE_CHANGESET_FOREIGN_KEY,
	SQLITE_CHANGESET_OMIT,
	SQLITE_CHANGESET_REPLACE,
	SQLITE_CHANGESET_ABORT,
};
