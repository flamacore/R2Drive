const fs = require('fs');
const path = require('path');

// Paths
const packageJsonPath = path.join(__dirname, 'package.json');
const tauriConfPath = path.join(__dirname, 'src-tauri', 'tauri.conf.json');

// Helper to increment patch version
function incrementVersion(version) {
    const parts = version.split('.');
    if (parts.length !== 3) throw new Error(`Invalid version format: ${version}`);
    parts[2] = parseInt(parts[2], 10) + 1;
    return parts.join('.');
}

// 1. Update package.json
console.log('Reading package.json...');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const oldVersion = packageJson.version;
const newVersion = incrementVersion(oldVersion);

console.log(`Bumping version: ${oldVersion} -> ${newVersion}`);
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n'); // Keep formatting

// 2. Update tauri.conf.json
console.log('Reading tauri.conf.json...');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));

// tauri.conf.json in v2 structure might have version at root or inside package
// Based on previous reads, it's at root "version": "0.1.0"
if (tauriConf.version) {
    tauriConf.version = newVersion;
} else if (tauriConf.package && tauriConf.package.version) {
    tauriConf.package.version = newVersion;
} else {
    console.warn("Could not find version in tauri.conf.json, skipping update for it.");
}

fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

console.log('Version bumped successfully.');
