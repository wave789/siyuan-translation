"use strict";
const { Plugin, Dialog, Setting, showMessage } = require("siyuan");
const { DEFAULTS, translate } = require("./core");

module.exports = class SelectionTranslator extends Plugin {
    async onload() {
        this.disposed = false;
        let saved;
        try { saved = await this.loadData("settings.json"); }
        catch { if (!this.disposed) showMessage("无法读取翻译配置，暂用默认设置；请检查插件存储。", 5000, "error"); }
        this.config = { ...DEFAULTS };
        if (saved && typeof saved === "object" && !Array.isArray(saved)) {
            for (const key of Object.keys(DEFAULTS)) {
                if (typeof saved[key] === "string") this.config[key] = saved[key];
            }
        }
        if (this.disposed) return;
        this.dialogs = new Set();
        this.addCommand({ langKey: "translateSelection", hotkey: "⌥T",
            callback: () => this.translateSelection(), editorCallback: () => this.translateSelection() });
        this.setupSettings();
        this.onKeyDown = event => {
            if (event.key !== "Alt") { this.altCandidate = false; return; }
            if (event.repeat || event.ctrlKey || event.shiftKey || event.metaKey || event.isComposing || event.getModifierState?.("AltGraph")) {
                this.altCandidate = false; return;
            }
            this.altCandidate = this.config.shortcut === "alt" && !!this.selectedText();
        };
        this.onKeyUp = event => {
            if (event.key !== "Alt") return;
            const run = this.altCandidate && !event.ctrlKey && !event.shiftKey && !event.metaKey;
            this.altCandidate = false;
            if (run) { event.preventDefault(); this.translateSelection(); }
        };
        this.onBlur = () => { this.altCandidate = false; };
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("keyup", this.onKeyUp, true);
        window.addEventListener("blur", this.onBlur);
    }

    selectedText() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
        const range = selection.getRangeAt(0);
        const element = node => node.nodeType === 1 ? node : node.parentElement;
        const start = element(range.startContainer)?.closest(".protyle-wysiwyg");
        const end = element(range.endContainer)?.closest(".protyle-wysiwyg");
        return start && start === end ? selection.toString().trim() : "";
    }

    setupSettings() {
        const fields = {};
        this.setting = new Setting({ confirmCallback: async () => {
            const next = { ...this.config };
            Object.entries(fields).forEach(([key, input]) => { next[key] = input.value.trim(); });
            try {
                await this.saveData("settings.json", next);
                this.config = next;
                showMessage("翻译设置已保存");
            } catch { showMessage("设置保存失败，请重试。", 5000, "error"); }
        } });
        const add = (key, title, description, options, secret = false) => {
            const input = document.createElement(options ? "select" : "input");
            input.className = options ? "b3-select" : "b3-text-field";
            if (options) options.forEach(([value, label]) => {
                const option = document.createElement("option"); option.value = value; option.textContent = label; input.append(option);
            });
            else { input.type = secret ? "password" : "text"; input.autocomplete = "off"; }
            input.value = this.config[key]; fields[key] = input;
            this.setting.addItem({ title, description, createActionElement: () => {
                input.value = this.config[key]; return input;
            } });
        };
        add("provider", "翻译服务", "只向当前选择的服务发送选中文本，不自动切换服务。", [["openai", "本地 LLM · OpenAI 兼容"], ["ollama", "本地 LLM · Ollama"], ["baidu", "百度通用翻译"]]);
        add("shortcut", "单独 Alt", "Alt+T 始终可用，可在思源快捷键设置中修改。单独 Alt 可能受系统菜单影响。", [["alt-t", "关闭（使用 Alt+T）"], ["alt", "启用：轻按并松开 Alt"]]);
        add("endpoint", "本地 LLM 完整 API 地址", "例如 http://127.0.0.1:8000/v1/chat/completions 或 http://127.0.0.1:11434/api/chat。地址须能从思源内核访问。");
        add("model", "模型名称", "填写服务实际加载的模型名。");
        add("ollamaThink", "Ollama 思考模式", "仅用于原生 /api/chat、/api/generate。仅返回思考内容时可尝试关闭；若模型不支持关闭，请恢复默认。", [["default", "模型默认"], ["off", "关闭思考（think: false）"]]);
        add("ollamaNumPredict", "Ollama 最大输出 token 数", "仅用于原生接口，默认 4096；截断时可尝试 8192。0 使用模型默认值。提高上限可能增加等待时间，实际输出仍受模型和服务端限制。");
        add("apiKey", "本地 LLM API Key", "服务无需认证时留空。", null, true);
        add("baiduAppId", "百度 APP ID", "百度翻译开放平台的通用翻译 APP ID。");
        add("baiduSecret", "百度密钥", "凭据保存在思源插件配置中，并非加密密钥库；请勿分享配置文件。", null, true);
    }

    async translateSelection() {
        if (this.busy || this.disposed) return;
        const text = this.selectedText();
        if (!text) { showMessage("请先选中笔记正文中的英文。"); return; }
        this.busy = true;
        const config = { ...this.config };
        const controller = new AbortController();
        this.controller = controller;
        let closed = false;
        let timedOut = false;
        let dialog;
        let status;
        let output;
        let copy;
        let cancel;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 125000);
        try {
            dialog = new Dialog({ title: "英文 → 中文", width: "640px",
                content: '<div class="selection-translator"><label>原文<textarea class="b3-text-field" data-source readonly></textarea></label><div class="selection-translator__status" role="status" aria-live="polite"></div><label>译文<textarea class="b3-text-field" data-result readonly placeholder="译文将在这里显示"></textarea></label><div class="selection-translator__actions"><button class="b3-button" data-copy disabled>复制译文</button><button class="b3-button b3-button--outline" data-cancel>取消请求</button></div></div>',
                destroyCallback: () => { closed = true; controller.abort(); clearTimeout(timer); this.dialogs.delete(dialog); },
            });
            this.dialogs.add(dialog);
            const root = dialog.element;
            status = root.querySelector('[role="status"]');
            output = root.querySelector("[data-result]");
            copy = root.querySelector("[data-copy]");
            cancel = root.querySelector("[data-cancel]");
            root.querySelector("[data-source]").value = text;
            status.textContent = `正在通过${config.provider === "baidu" ? "百度翻译" : "本地 LLM"}翻译…`;
            cancel.onclick = () => { controller.abort(); };
            copy.onclick = async () => {
                try { await navigator.clipboard.writeText(output.value); showMessage("译文已复制"); }
                catch { output.focus(); output.select(); showMessage("请按 Ctrl+C 复制选中的译文。"); }
            };
            const result = await translate(text, config, { signal: controller.signal });
            if (!closed && !controller.signal.aborted) {
                output.value = result; copy.disabled = false; status.textContent = "翻译完成";
            }
        } catch (error) {
            if (!status || !output || !copy || !cancel) {
                dialog?.destroy();
                if (!this.disposed) showMessage("翻译窗口创建失败，请重新启用插件后重试。", 5000, "error");
                return;
            }
            if (!closed && !controller.signal.aborted && error.code === "TRANSLATION_TRUNCATED" && error.partialTranslation) {
                output.value = error.partialTranslation;
                copy.disabled = false;
                copy.textContent = "复制部分译文";
            }
            if (!closed) status.textContent = controller.signal.aborted
                ? timedOut ? "翻译超时，请缩小选中范围或检查模型服务。" : "已取消（服务端可能仍在处理请求）。"
                : error instanceof TypeError ? "网络连接失败，请检查思源和翻译服务。" : error.message;
        } finally {
            clearTimeout(timer); this.busy = false;
            if (this.controller === controller) this.controller = null;
            if (!closed && cancel) { cancel.textContent = "关闭"; cancel.onclick = () => dialog.destroy(); }
        }
    }

    onunload() {
        this.disposed = true;
        this.controller?.abort();
        for (const dialog of this.dialogs || []) dialog.destroy();
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("keyup", this.onKeyUp, true);
        window.removeEventListener("blur", this.onBlur);
    }
};
