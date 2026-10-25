/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

const esbuild = require("esbuild");
const { hostBuildOptions } = require("./esbuild-options.cjs");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		...hostBuildOptions,
		entryPoints: [
			'src/extension.ts'
		],
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		outfile: 'dist/extension.js',
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});	

	// React webview bundles (browser)
	const webviewCtx = await esbuild.context({
		entryPoints: {
			sidebar: 'webview-ui/sidebar/main.tsx',
			settings: 'webview-ui/settings/main.tsx',
		},
		bundle: true,
		format: 'iife',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'browser',
		target: ['es2020'],
		outdir: 'dist/webview',
		loader: { '.css': 'css' },
		define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	});

	if (watch) {
		await Promise.all([ctx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([ctx.rebuild(), webviewCtx.rebuild()]);
		await ctx.dispose();
		await webviewCtx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
