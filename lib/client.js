/* dsh-compaction-counter — client half.
 *
 * Loader bundle format: executing this file only registers the factory; the
 * factory body runs when the module is first materialized. The browser half
 * adds one `conversation.composer.dock` entry. The dock renders its slot
 * entries first and the built-in `ContextMeter` last, so the entry carries
 * `order: 1` to become a flex sibling to the meter's right.
 *
 * The count itself comes from the host-side `compactionStats` session
 * projection through the standard `useProjection` hook seat.
 */
window.__ModuleLoader__.load({
  id: "dsh-compaction-counter",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-compaction-counter";
    var PROJECTION_KEY = "compactionStats";
    var SLOT = "conversation.composer.dock";

    var zh = {
      label: "压缩 {count} 次",
      title:
        "本会话上下文压缩：共触发 {count} 次（成功 {completed}，失败 {failed}，手动 {manual}）",
      lastAt: "最近触发：{time}",
      lastTokens: "上次压缩约 {tokens} tokens",
      lastError: "上次失败：{message}",
      empty: "本会话尚未触发上下文压缩",
    };

    var en = {
      label: "{count} compactions",
      title:
        "Context compactions this session: {count} total ({completed} succeeded, {failed} failed, {manual} manual)",
      lastAt: "Last triggered: {time}",
      lastTokens: "Last compaction covered ~{tokens} tokens",
      lastError: "Last failure: {message}",
      empty: "No context compaction in this session yet",
    };

    var STYLE = [
      ".dsh-compaction-count{",
      "order:1;display:inline-flex;align-items:center;flex:none;gap:4px;",
      "padding:1px 8px;border-radius:var(--dsw-radius-sm);",
      "color:var(--dsw-alias-label-tertiary);font-family:inherit;",
      "font-size:var(--dsh-content-font-size-secondary,13px);",
      "font-variant-numeric:tabular-nums;",
      "line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));",
      "white-space:nowrap;user-select:none;cursor:default;",
      "}",
      ".dsh-compaction-count:hover{",
      "background:var(--dsw-alias-interactive-bg-hover);",
      "color:var(--dsw-alias-label-secondary);",
      "}",
    ].join("");

    /** Compact token count for the hover title. */
    function formatTokens(value) {
      if (value < 1000) return String(Math.round(value));
      if (value < 1000000) return (Math.round(value / 100) / 10).toFixed(1) + "k";
      return (Math.round(value / 100000) / 10).toFixed(1) + "M";
    }

    /**
     * The dock entry: one tertiary line item sharing the context meter's type
     * and spacing. Renders nothing until the Session projection value arrives.
     */
    function CompactionCount(props) {
      var stats = props.useProjection(PROJECTION_KEY);
      if (stats === undefined || stats === null) return null;

      var t = props.t;
      var count = Number.isFinite(stats.count) ? stats.count : 0;
      var lines = [
        count === 0
          ? t("empty")
          : t("title", {
              count: count,
              completed: Number.isFinite(stats.completed) ? stats.completed : 0,
              failed: Number.isFinite(stats.failed) ? stats.failed : 0,
              manual: Number.isFinite(stats.manual) ? stats.manual : 0,
            }),
      ];

      if (count > 0) {
        if (Number.isFinite(stats.lastAt) && stats.lastAt > 0) {
          lines.push(t("lastAt", { time: new Date(stats.lastAt).toLocaleString() }));
        }
        if (Number.isFinite(stats.lastTokens) && stats.lastTokens > 0) {
          lines.push(t("lastTokens", { tokens: formatTokens(stats.lastTokens) }));
        }
        if (typeof stats.lastError === "string" && stats.lastError !== "") {
          lines.push(t("lastError", { message: stats.lastError }));
        }
      }

      var title = lines.join("\n");
      return h(
        "span",
        {
          className: "dsh-compaction-count",
          "data-compaction-count": String(count),
          role: "status",
          title: title,
          "aria-label": title,
        },
        t("label", { count: count }),
      );
    }

    var inject = ["slots", "locale"];

    /**
     * Register the locale dictionary, the entry style, and the dock entry.
     * Everything rides one effect so unloading the plugin removes it all.
     * @param {import('@deepseek-ai/cordis').Context} ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(function* () {
        yield ctx.locale.register(NS, { zh: zh, en: en });

        var style = document.createElement("style");
        style.dataset.plugin = "dsh-compaction-counter";
        style.textContent = STYLE;
        document.head.appendChild(style);
        yield () => {
          style.remove();
        };

        yield ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: "compaction-counter",
              order: 2,
              locale: NS,
            },
            CompactionCount,
          ),
        );
      }, "compaction-counter: locale, style, composer dock");
    }

    module.exports = {
      name: "compaction-counter",
      apply: apply,
      inject: inject,
    };
    return module.exports;
  },
});