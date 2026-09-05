// CCG - Claude + Codex + Antigravity Multi-Model Collaboration System
export * from './types'
export { doctor, status } from './commands/doctor'
export { init } from './commands/init'
export { showMainMenu } from './commands/menu'
export { update } from './commands/update'
export { i18n, initI18n, changeLanguage } from './i18n'
export {
  readCcgConfig,
  writeCcgConfig,
  createDefaultConfig,
  createDefaultRouting,
  getCcgDir,
  getConfigPath,
} from './utils/config'
export {
  configureApiMartForCodex,
  getWorkflowConfigs,
  getWorkflowById,
  installWorkflows,
  syncRoutingTemplates,
  installAceTool,
  installAceToolRs,
  installCodexMode,
  removeApiMartFromCodex,
  uninstallCodexMode,
  uninstallWorkflows,
  uninstallAceTool,
} from './utils/installer'
export {
  DSH_PLUGIN_NAME,
  defaultDshHome,
  dshPluginDir,
  findDshProfiles,
  hasDshHome,
  installDshPlugin,
  uninstallDshPlugin,
} from './utils/installer-dsh'
export { migrateToV1_4_0, needsMigration } from './utils/migration'
export { getCurrentVersion, getLatestVersion, checkForUpdates, compareVersions } from './utils/version'
