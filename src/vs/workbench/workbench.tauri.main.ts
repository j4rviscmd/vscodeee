/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VS Codeee Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// #######################################################################
// ###                                                                 ###
// ### !!! PLEASE ADD COMMON IMPORTS INTO WORKBENCH.COMMON.MAIN.TS !!! ###
// ###                                                                 ###
// #######################################################################

//#region --- workbench common

import './workbench.common.main.js';

//#endregion


//#region --- workbench parts

import './browser/parts/dialogs/dialog.web.contribution.js';

//#endregion


//#region --- workbench (Tauri main)

import './tauri-browser/desktop.tauri.main.js';

//#endregion


//#region --- workbench actions (Tauri-specific)

import './tauri-browser/actions/developerActions.js';
import './tauri-browser/actions/nativeActions.js';

//#endregion


//#region --- workbench services (Tauri-specific overrides)

import './services/lifecycle/tauri-browser/lifecycleService.js';
import './services/host/tauri-browser/hostService.js';
import './services/title/tauri-browser/titleService.js';
import './services/extensionManagement/tauri-browser/tauriBuiltinExtensionsScannerService.js';

//#endregion


//#region --- workbench services (browser-compatible, reused from web)
//
// Tauri's WebView is a browser environment, so we can reuse the browser
// service implementations. In later phases, some of these may be replaced
// with Tauri-native implementations (e.g., file dialogs, clipboard).

import './services/integrity/browser/integrityService.js';
import './services/search/browser/searchService.js';
import './services/textfile/browser/browserTextFileService.js';
import './services/keybinding/browser/keyboardLayoutService.js';
import './services/extensions/tauri-browser/tauriExtensionService.js';
import './services/extensionManagement/browser/extensionsProfileScannerService.js';
import './services/extensions/browser/extensionsScannerService.js';
import './services/extensionManagement/browser/webExtensionsScannerService.js';
import './services/extensionManagement/tauri-browser/tauriExtensionsScannerService.js';
import './services/extensionManagement/tauri-browser/tauriExtensionManagementServerService.js';
import './services/mcp/browser/mcpWorkbenchManagementService.js';
import './services/extensionManagement/browser/extensionGalleryManifestService.js';
import './services/telemetry/browser/telemetryService.js';
import './services/url/browser/urlService.js';
import './services/update/browser/updateService.js';
import './services/workspaces/browser/workspacesService.js';
import './services/workspaces/browser/workspaceEditingService.js';
import './services/dialogs/tauri-browser/fileDialogService.js';
import '../platform/meteredConnection/browser/meteredConnectionService.js';
import './services/clipboard/browser/clipboardService.js';
import './services/localization/browser/localeService.js';
import './services/path/browser/pathService.js';
import './services/themes/tauri-browser/tauriHostColorSchemeService.js';
import './services/encryption/browser/encryptionService.js';
import './services/imageResize/browser/imageResizeService.js';
import './services/secrets/browser/secretStorageService.js';
import './services/workingCopy/tauri-browser/workingCopyBackupService.js';
import './services/tunnel/browser/tunnelService.js';
import './services/files/browser/elevatedFileService.js';
import './services/workingCopy/browser/workingCopyHistoryService.js';
import './services/userDataSync/browser/webUserDataSyncEnablementService.js';
import './services/userDataProfile/browser/userDataProfileStorageService.js';
import './services/configurationResolver/browser/configurationResolverService.js';
import '../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import './services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import './services/browserElements/browser/webBrowserElementsService.js';
import './services/power/tauri-browser/powerService.js';
import '../platform/sandbox/browser/sandboxHelperService.js';

//#endregion


//#region --- workbench services (singleton registrations)

import { InstantiationType, registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IAccessibilityService } from '../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../platform/accessibility/browser/accessibilityService.js';
import { IContextMenuService } from '../platform/contextview/browser/contextView.js';
import { ContextMenuService } from '../platform/contextview/browser/contextMenuService.js';
import { IExtensionTipsService } from '../platform/extensionManagement/common/extensionManagement.js';
import { ExtensionTipsService } from '../platform/extensionManagement/common/extensionTipsService.js';
import { IWorkbenchExtensionManagementService } from './services/extensionManagement/common/extensionManagement.js';
import { ExtensionManagementService } from './services/extensionManagement/common/extensionManagementService.js';
import { UserDataSyncMachinesService, IUserDataSyncMachinesService } from '../platform/userDataSync/common/userDataSyncMachines.js';
import { IUserDataSyncStoreService, IUserDataSyncService, IUserDataAutoSyncService, IUserDataSyncLocalStoreService, IUserDataSyncResourceProviderService, IUserDataSyncStoreManagementService } from '../platform/userDataSync/common/userDataSync.js';
import { UserDataSyncStoreService, UserDataSyncStoreManagementService } from '../platform/userDataSync/common/userDataSyncStoreService.js';
import { UserDataSyncLocalStoreService } from '../platform/userDataSync/common/userDataSyncLocalStoreService.js';
import { UserDataSyncService } from '../platform/userDataSync/common/userDataSyncService.js';
import { IUserDataSyncAccountService, UserDataSyncAccountService } from '../platform/userDataSync/common/userDataSyncAccount.js';
import { UserDataAutoSyncService } from '../platform/userDataSync/common/userDataAutoSyncService.js';
import { ICustomEndpointTelemetryService } from '../platform/telemetry/common/telemetry.js';
import { NullEndpointTelemetryService } from '../platform/telemetry/common/telemetryUtils.js';
import { ITimerService, TimerService } from './services/timer/browser/timerService.js';
import { IDiagnosticsService, NullDiagnosticsService } from '../platform/diagnostics/common/diagnostics.js';
import { ILanguagePackService } from '../platform/languagePacks/common/languagePacks.js';
import { WebLanguagePacksService } from '../platform/languagePacks/browser/languagePacks.js';
import { IWebContentExtractorService, NullWebContentExtractorService, ISharedWebContentExtractorService, NullSharedWebContentExtractorService } from '../platform/webContentExtractor/common/webContentExtractor.js';
import { IMcpGalleryManifestService } from '../platform/mcp/common/mcpGalleryManifest.js';
import { WorkbenchMcpGalleryManifestService } from './services/mcp/browser/mcpGalleryManifestService.js';
import { UserDataSyncResourceProviderService } from '../platform/userDataSync/common/userDataSyncResourceProvider.js';
import { IUserDataInitializationService, UserDataInitializationService } from './services/userData/browser/userDataInit.js';
import { SyncDescriptor } from '../platform/instantiation/common/descriptors.js';

registerSingleton(IWorkbenchExtensionManagementService, ExtensionManagementService, InstantiationType.Delayed);
registerSingleton(IAccessibilityService, AccessibilityService, InstantiationType.Delayed);
registerSingleton(IContextMenuService, ContextMenuService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncStoreService, UserDataSyncStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncMachinesService, UserDataSyncMachinesService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncLocalStoreService, UserDataSyncLocalStoreService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncAccountService, UserDataSyncAccountService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncService, UserDataSyncService, InstantiationType.Delayed);
registerSingleton(IUserDataSyncResourceProviderService, UserDataSyncResourceProviderService, InstantiationType.Delayed);
registerSingleton(IUserDataAutoSyncService, UserDataAutoSyncService, InstantiationType.Eager);
registerSingleton(IExtensionTipsService, ExtensionTipsService, InstantiationType.Delayed);
registerSingleton(ITimerService, TimerService, InstantiationType.Delayed);
registerSingleton(ICustomEndpointTelemetryService, NullEndpointTelemetryService, InstantiationType.Delayed);
registerSingleton(IDiagnosticsService, NullDiagnosticsService, InstantiationType.Delayed);
registerSingleton(ILanguagePackService, WebLanguagePacksService, InstantiationType.Delayed);
registerSingleton(IWebContentExtractorService, NullWebContentExtractorService, InstantiationType.Delayed);
registerSingleton(ISharedWebContentExtractorService, NullSharedWebContentExtractorService, InstantiationType.Delayed);
registerSingleton(IMcpGalleryManifestService, WorkbenchMcpGalleryManifestService, InstantiationType.Delayed);
registerSingleton(IUserDataInitializationService, new SyncDescriptor(UserDataInitializationService, [[]], true));
registerSingleton(IUserDataSyncStoreManagementService, UserDataSyncStoreManagementService, InstantiationType.Delayed);

//#endregion


//#region --- workbench contributions

// Logs
import './contrib/logs/browser/logs.contribution.js';

// Localization
import './contrib/localization/browser/localization.contribution.js';

// Performance
import './contrib/performance/browser/performance.web.contribution.js';

// Preferences
import './contrib/preferences/browser/keyboardLayoutPicker.js';

// Debug
import './contrib/debug/browser/extensionHostDebugService.js';

// Welcome Banner
import './contrib/welcomeBanner/browser/welcomeBanner.contribution.js';

// Webview
import './contrib/webview/browser/webview.web.contribution.js';

// Extensions Management
import './contrib/extensions/browser/extensions.web.contribution.js';

// Terminal
import './contrib/terminal/browser/terminal.web.contribution.js';
import './contrib/externalTerminal/browser/externalTerminal.contribution.js';
import './contrib/terminal/browser/terminalInstanceService.js';
import './contrib/terminal/tauri-browser/tauriTerminalBackend.js';

// Tasks
import './contrib/tasks/browser/taskService.js';

// Tags
import './contrib/tags/browser/workspaceTagsService.js';

// Issue Reporting
import './contrib/issue/browser/issue.contribution.js';

// Browser View (CDP)
import './contrib/browserView/browser/browserView.contribution.js';

// Process Explorer
import './contrib/processExplorer/browser/processExplorer.web.contribution.js';

// Remote
import './contrib/remote/browser/remoteStartEntry.contribution.js';

// Splash
import './contrib/splash/browser/splash.contribution.js';

//#endregion
