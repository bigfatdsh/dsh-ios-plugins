/**
 * Host half of the mobile / iOS adaptation layer.
 *
 * Two jobs:
 *  1. The served index must carry the mobile viewport contract (`viewport-fit=cover`,
 *     `interactive-widget`): iOS reads it before any script runs, and
 *     `env(safe-area-inset-*)` resolves from it.
 *  2. `GET /dsh-mobile/cost` reports this session's spend, read from the session
 *     projection cache. The browser half shows it in a fixed corner badge, because
 *     the composer's own cost pill sits where a phone keyboard covers it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const VIEWPORT =
	"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";

const VIEWPORT_TAG = `<meta name="viewport" content="${VIEWPORT}" />`;
const THEME_TAG = '<meta name="theme-color" content="#ffffff" />';
const CAPABLE_TAG = '<meta name="apple-mobile-web-app-capable" content="yes" />';

/**
 * Rewrite the served index: force the mobile viewport contract and add the iOS
 * status-bar tags when they are missing.
 * @param html - the composed index document.
 * @returns the adapted document.
 */
export function patchIndex(html) {
	if (typeof html !== "string" || html.length === 0) return html;
	let out = html;
	const viewport = /<meta\s+name=["']viewport["'][^>]*>/i;
	if (viewport.test(out)) out = out.replace(viewport, VIEWPORT_TAG);
	else out = out.replace(/<\/head>/i, `    ${VIEWPORT_TAG}\n  </head>`);
	if (!/<meta\s+name=["']theme-color["']/i.test(out)) {
		out = out.replace(/<\/head>/i, `    ${THEME_TAG}\n  </head>`);
	}
	if (!/<meta\s+name=["']apple-mobile-web-app-capable["']/i.test(out)) {
		out = out.replace(/<\/head>/i, `    ${CAPABLE_TAG}\n  </head>`);
	}
	return out;
}

/** `$DSH_HOME/storages/session_projcache/sessions`. */
function cacheDirectory() {
	const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
	return path.join(home, "storages", "session_projcache", "sessions");
}

/**
 * Newest session-cost cell in the projection cache.
 *
 * The cache is written per session and refreshed on every event, so the file
 * with the latest modification time is the session being used. Reading it keeps
 * the badge independent of the browser's slot rendering.
 * @returns the cost view, or undefined when no session has a cost yet.
 */
export async function readSessionCost(directory = cacheDirectory()) {
	let names;
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
	} catch {
		return undefined;
	}
	const ranked = await Promise.all(
		names.map(async (name) => {
			const file = path.join(directory, name);
			try {
				return { file, name, at: (await stat(file)).mtimeMs };
			} catch {
				return undefined;
			}
		})
	);
	const newest = ranked.filter(Boolean).sort((left, right) => right.at - left.at)[0];
	if (newest === undefined) return undefined;
	let record;
	try {
		record = JSON.parse(await readFile(newest.file, "utf8"));
	} catch {
		return undefined;
	}
	const cell = record?.record?.rows?.sessionCost;
	const value = cell?.val;
	if (typeof value !== "object" || value === null) return undefined;
	const micros = Number(value.micros ?? 0);
	if (!Number.isFinite(micros)) return undefined;
	return {
		session: newest.name.replace(/\.json$/, ""),
		micros,
		currency: typeof value.currency === "string" ? value.currency : "CNY",
		estimatedMicros: Number(value.estimatedMicros ?? 0) || 0,
		unpricedTokens: Number(value.unpricedTokens ?? 0) || 0,
		seq: Number(cell.seq ?? 0) || 0,
	};
}

export function apply(ctx) {
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(
			() => webCtx.webServer.tapIndex((html) => patchIndex(html)),
			"mobile-ios: index viewport contract"
		);
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "exact",
					path: "/dsh-mobile/cost",
					handler: async (req, res) => {
						let body;
						try {
							body = (await readSessionCost()) ?? null;
						} catch (error) {
							body = { error: String(error?.message ?? error) };
						}
						res.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store",
						});
						res.end(JSON.stringify(body));
					},
				}),
			"mobile-ios: session cost route"
		);
	});
}
