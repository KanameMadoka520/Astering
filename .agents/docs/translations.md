# Translations

User-facing strings must be translatable.

- Frontend: source strings in `frontend/src/i18n/lang/en.json`. In components: `const {t} = useI18n({useScope: 'global'})`, then `t('your.key')`.
- API (mostly notifications): source strings in `pkg/i18n/lang/en.json`. Use `i18n.T(lang, "your.key", params...)`.
- 本 fork 要求新增或修改的用户文案同步维护对应目录的 `en.json` 和 `zh-CN.json`，中文通俗易懂，英文含义一致，翻译键与插值参数保持对应；不能仅依赖英文 fallback 掩盖缺失。上游的外部翻译流程不限制本 fork 完成中英文翻译。
- 保留其他已有语言和翻译键，不为无关改动大批重译。中英文验收包含空状态、加载、错误、操作确认、可访问性标签及设置说明，不能只检查主界面标题。
- Before adding a new string, check if a string with the same value already exists. If it does, use the existing key.
