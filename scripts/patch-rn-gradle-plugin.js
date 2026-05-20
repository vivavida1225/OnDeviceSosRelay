const fs = require('fs');
const path = require('path');

const settingsPath = path.join(
  __dirname,
  '..',
  'node_modules',
  '@react-native',
  'gradle-plugin',
  'settings.gradle.kts',
);

if (!fs.existsSync(settingsPath)) {
  process.exit(0);
}

const before =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("0.5.0")';
const after =
  'id("org.gradle.toolchains.foojay-resolver-convention").version("1.0.0")';
const content = fs.readFileSync(settingsPath, 'utf8');

if (content.includes(before)) {
  fs.writeFileSync(settingsPath, content.replace(before, after));
}
