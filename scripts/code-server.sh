#!/usr/bin/env bash

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname $(dirname $(realpath "$0")))
else
	ROOT=$(dirname $(dirname $(readlink -f $0)))
fi

function code() {
	pushd $ROOT


	NODE=$(node build/lib/node.ts)
	if [ ! -e $NODE ];then
		# Load remote node
		npm run gulp node
	fi

	popd

	NODE_ENV=development \
	VSCODE_DEV=1 \
	$NODE $ROOT/scripts/code-server.js "$@"
}

code "$@"
