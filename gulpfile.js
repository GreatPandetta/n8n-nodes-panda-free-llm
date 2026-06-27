const { src, dest } = require('gulp');

// Copies node/credential icons (svg/png) into the dist folder so n8n can display them.
function buildIcons() {
	return src('nodes/**/*.{png,svg}').pipe(dest('dist/nodes'));
}

exports['build:icons'] = buildIcons;
