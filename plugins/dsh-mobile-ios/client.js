window.__ModuleLoader__.load({
	id: "dsh-mobile-ios",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const PHONE = "(max-width: 820px)";

		/*
		 * Deliberately conservative: the shipped desktop layout already switches
		 * to a drawer under 768px, and every rule here has to hold up while the
		 * iOS keyboard animates. Nothing touches typography or the composer's
		 * inner padding -- an earlier build forced a 16px editor font to stop
		 * focus zoom and made the composer look wrong.
		 */
		const CSS = [
			":root{--dsh-sat:env(safe-area-inset-top,0px);--dsh-sab:env(safe-area-inset-bottom,0px);--dsh-sal:env(safe-area-inset-left,0px);--dsh-sar:env(safe-area-inset-right,0px);--dsh-kb:0px}",
			"html{-webkit-text-size-adjust:100%;text-size-adjust:100%;height:100%}",
			"body{height:100%;margin:0;background:var(--dsw-alias-bg-base,#fff);-webkit-tap-highlight-color:transparent;overscroll-behavior:none}",
			"#root{height:100dvh}",
			/* iOS reports darwin; a phone's inset is the status bar, not a 48px titlebar */
			"html[data-platform=darwin]{--dsh-frame-top-clearance:var(--dsh-sat);--dsh-frame-overlay-top:calc(var(--dsh-sat) + 12px)}",
			"button,[role=button],a,input,textarea,select{touch-action:manipulation}",
			/* drawer */
			"[data-sidebar-drawer] [class*=_sidebarCol]{max-width:min(88vw,420px);box-shadow:0 8px 32px rgb(0 0 0 / .22);border-right:0}",
			"[data-sidebar-drawer] [class*=_drawerMask]{background:rgb(0 0 0 / .34)}",
			"[data-sidebar-drawer] [class*=_leadingSeat]{left:calc(12px + var(--dsh-sal));top:calc(11px + var(--dsh-sat))}",
			/* dialogs and preview sheets */
			"[role=dialog]{max-width:min(94vw,760px);max-height:calc(100dvh - var(--dsh-sat) - var(--dsh-sab) - 16px);overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}",
			"[data-dsh-sheet]{box-sizing:border-box;max-height:calc(100dvh - var(--dsh-sat));overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;border-radius:16px 16px 0 0;padding-bottom:var(--dsh-sab)}",
			/* never scroll the page sideways */
			"pre,.md-code-block{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}",
			"table,.md-table-wide{max-width:100%;overflow-x:auto}",
			".dsh-mobile-cost{font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap;padding:1px 8px}",
			/* keyboard: only when iOS did NOT resize the layout viewport for us */
			"body[data-dsh-kb=1] [class*=_mainPanel]{padding-bottom:var(--dsh-kb)}",
			/* cost HUD: mirrors the composer's cost pill where it cannot be missed */
			"@media " + PHONE + "{",
			"  [role=dialog]{width:100vw;max-width:100vw;max-height:calc(100dvh - var(--dsh-sat));margin:0;border-radius:0 0 16px 16px;padding-bottom:var(--dsh-sab)}",
			"  .dshwv-root{--dshw-scale:.62;right:calc(6px + var(--dsh-sar));bottom:calc(var(--dsh-sab) + 54px)}",
			"}"
		].join("\n");

		function ensureStyle() {
			if (document.getElementById("dsh-mobile-ios-style")) return;
			const style = document.createElement("style");
			style.id = "dsh-mobile-ios-style";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function ensureMeta() {
			const viewport = document.querySelector('meta[name="viewport"]');
			if (viewport && !/viewport-fit=cover/.test(viewport.getAttribute("content") ?? "")) {
				viewport.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content");
			}
		}

		/* ---- keyboard: shift only the part iOS left under the keyboard ---- */
		let baseHeight = window.innerHeight;
		function syncViewport() {
			const vv = window.visualViewport;
			const visible = vv ? vv.height : window.innerHeight;
			const inset = vv ? vv.offsetTop : 0;
			// Height the platform already took away by resizing the layout viewport.
			const applied = Math.max(0, baseHeight - window.innerHeight);
			const covered = Math.max(0, window.innerHeight - visible - inset);
			const extra = Math.max(0, Math.round(covered - applied));
			document.documentElement.style.setProperty("--dsh-kb", extra + "px");
			document.body.dataset.dshKb = extra > 60 ? "1" : "0";
		}

		/* ---- cost HUD ------------------------------------------------------ */
		function tagSheets() {
			const nodes = [document.body, ...document.body.querySelectorAll("div,section,aside")];
			for (const node of nodes) {
				if (!(node instanceof HTMLElement) || node.dataset.dshSheet !== undefined) continue;
				if (node.getAttribute("role") === "dialog") continue;
				const rect = node.getBoundingClientRect();
				if (rect.width < window.innerWidth * 0.8 || rect.height < window.innerHeight * 0.45) continue;
				const style = getComputedStyle(node);
				if (style.position !== "fixed" && style.position !== "absolute") continue;
				if (!(Number.parseInt(style.zIndex, 10) >= 100)) continue;
				node.dataset.dshSheet = "1";
			}
		}

		/**
		 * Spends in the composer dock, next to the token pills.
		 *
		 * `dsh-session-cost` renders its own pill there; when that one is missing this
		 * badge takes its place in the same row -- it is layout, not an overlay, so
		 * nothing on screen is covered. The amount comes from GET /dsh-mobile/cost.
		 */
		function CostBadge() {
			const React = require("react");
			const [text, setText] = React.useState("");
			React.useEffect(() => {
				let alive = true;
				const load = async () => {
					// The plugin's own pill wins whenever it actually shows a number
					// (its label can be squeezed down to an ellipsis on a phone).
					const pill = document.querySelector("[data-session-cost]");
					if (pill !== null && /\d/.test(pill.textContent)) {
						if (alive) setText("");
						return;
					}
					let view = null;
					try {
						const response = await fetch("/dsh-mobile/cost", { cache: "no-store", credentials: "same-origin" });
						view = await response.json();
					} catch {
						view = null;
					}
					if (!alive || view === null || typeof view.micros !== "number") return;
					const symbol = view.currency === "USD" ? "$" : "\u00a5";
					setText(symbol + (view.micros / 1e6).toFixed(2));
				};
				void load();
				const timer = setInterval(load, 5000);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			if (text === "") return null;
			return React.createElement("span", { className: "dsh-mobile-cost", title: "\u672c\u4f1a\u8bdd\u7d2f\u8ba1\u82b1\u8d39" }, text);
		}

		function apply(ctx) {
			ensureMeta();
			ensureStyle();
			syncViewport();
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register(
					{ name: "conversation.composer.dock", id: "mobile-cost", order: 2 },
					CostBadge
				)
			);
			const onViewport = () => syncViewport();
			const onWidth = () => {
				// Rotation moves the baseline, not just the keyboard.
				baseHeight = window.innerHeight;
				syncViewport();
			};
			const tick = () => {
					tagSheets();
			};
			window.addEventListener("resize", onViewport, { passive: true });
			window.addEventListener("orientationchange", onWidth, { passive: true });
			window.visualViewport?.addEventListener("resize", onViewport, { passive: true });
			window.visualViewport?.addEventListener("scroll", onViewport, { passive: true });
			const timer = setInterval(tick, 1500);
			window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
