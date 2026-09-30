// Metro must also watch ../shared, the TypeScript shared with the web app (types and formatting helpers).
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "../shared")];
// Only resolve packages from the app's own node_modules, never the web app's.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, "node_modules")];

module.exports = config;
