/**
 * Installs the VSIX matching the current package.json version.
 * Used by: npm run update-ext
 */
const { execSync } = require('child_process');
const { version, name } = require('../package.json');

const vsix = `${name}-${version}.vsix`;
console.log(`Installing ${vsix} ...`);
execSync(`code --install-extension ${vsix} --force`, { stdio: 'inherit' });
console.log('Done. Reload the VS Code window (Ctrl+Shift+P -> Developer: Reload Window).');
