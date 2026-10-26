window.__ModuleLoader__.load({
	id: "dsh-fast-loop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const en = {
			title: "Agent loop",
			description: "Control how the Agent dispatches tool calls.",
			maxParallel: "Parallel tool calls",
			maxParallelHint: "Upper bound on parallel-safe calls running at once within one step.",
			overridden: "Overridden",
			reset: "Reset to default",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct.",
			invalidNumber: "Enter a number, or leave blank to use the default."
		};

		const zh = {
			title: "Agent 循环",
			description: "控制 Agent 派发工具调用的方式。",
			maxParallel: "并行工具调用数",
			maxParallelHint: "同一步内最多同时运行多少个可并行的调用。",
			overridden: "已覆盖",
			reset: "恢复默认",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。",
			invalidNumber: "请填数字；留空表示使用默认值。"
		};

		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}

		function AgentLoopCard(props) {
			const { t } = props;
			const state = props.useAgentLoopCard((snapshot) => snapshot);
			if (props.view === "summary") return t("description");
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: props.save,
				onDiscard: props.discard,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
					id: "plugin-config-agent-loop-parallel",
					label: t("maxParallel"),
					hint: t("maxParallelHint"),
					overriddenLabel: t("overridden"),
					resetLabel: t("reset"),
					invalidLabel: t("invalidNumber"),
					numeric: true,
					disabled: !state.writable,
					...state.maxParallelToolCalls,
					onEdit: (text) => {
						props.edit("maxParallelToolCalls", text);
					},
					onReset: () => {
						props.resetField("maxParallelToolCalls");
					}
				})
			});
		}

		var AgentLoopCardController = class {
			form;
			store;
			constructor(scope) {
				this.form = new _deepseek_ai_dsh_client_ui_primitives.SettingsFormModel(scope, [
					(0, _deepseek_ai_dsh_client_ui_primitives.settingsNumberField)("maxParallelToolCalls")
				]);
				this.store = this.form.bind(() => this.projection());
			}
			projection() {
				return {
					...this.form.shell(),
					maxParallelToolCalls: this.form.field("maxParallelToolCalls")
				};
			}
			inject() {
				return {
					hooks: { agentLoopCard: this.store },
					...this.form.actions()
				};
			}
			dispose() {
				this.form.dispose();
			}
		};

		const NS = "settings.fastLoop";
		const inject = [
			"slots",
			"locale",
			"configForms"
		];

		const LOOP_NAMESPACES = ["fast-loop", "agent-loop"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-settings-fast-loop: dictionaries");

			ctx.effect(() => ctx.configForms.whileServed(LOOP_NAMESPACES, (served) => {
				const activeNs = served.has("fast-loop") ? "fast-loop" : "agent-loop";
				const card = new AgentLoopCardController(ctx.configForms.get(activeNs));
				const cleanupSlot = ctx.slots.inject("plugins.item", () => ctx.slots.register({
					name: "plugins.item",
					id: "agent-loop",
					order: 30,
					label: () => t("title"),
					locale: NS,
					inject: () => card.inject()
				}, AgentLoopCard));

				return () => {
					cleanupSlot();
					card.dispose();
				};
			}), "ui-settings-fast-loop: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
