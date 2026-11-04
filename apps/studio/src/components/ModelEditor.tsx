import { useEffect, useState } from 'react';
import type { ToolCapability } from '@qiansi/engine';
import { Check, Download, FlaskConical, Plus, RefreshCw, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import {
  PROVIDER_PRESETS,
  catalogOf,
  initialModels,
  preferredModel,
  toolLabels,
  type ConnectionStatus,
  type ModelDraft,
} from '../data/models';

interface ModelEditorProps {
  open: boolean;
  models: ModelDraft[];
  onChange: (models: ModelDraft[]) => void;
  onClose: () => void;
  /** Applies each connection's cheapest capable model to every canvas node. */
  onApplyPreferred?: (models: ModelDraft[]) => void | Promise<void>;
}

interface CcProvider {
  id: string;
  name: string;
  baseUrl: string;
  protocol: string;
  isCurrent: boolean;
}

const statusText: Record<ConnectionStatus, string> = {
  untested: '未测试',
  testing: '测试中…',
  ok: '连通',
  fail: '失败',
};

const toolKeys = Object.keys(toolLabels) as ToolCapability[];

export function ModelEditor({ open, models, onChange, onClose, onApplyPreferred }: ModelEditorProps) {
  const [drafts, setDrafts] = useState<ModelDraft[]>(models);
  const [selectedId, setSelectedId] = useState(models[0]?.id ?? '');
  const [vaultRefs, setVaultRefs] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');

  // cc-switch style onboarding: provider → key → official model catalog → pick.
  const [creating, setCreating] = useState(false);
  const [presetKey, setPresetKey] = useState(PROVIDER_PRESETS[0].key);
  const [newLabel, setNewLabel] = useState(PROVIDER_PRESETS[0].label);
  const [newProvider, setNewProvider] = useState(PROVIDER_PRESETS[0].provider);
  const [newProtocol, setNewProtocol] = useState<'openai-chat' | 'anthropic-messages'>(
    PROVIDER_PRESETS[0].protocol
  );
  const [newBaseUrl, setNewBaseUrl] = useState(PROVIDER_PRESETS[0].baseUrl);
  const [newKey, setNewKey] = useState('');
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [fetchError, setFetchError] = useState('');
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [createError, setCreateError] = useState('');

  // CC Switch import.
  const [importOpen, setImportOpen] = useState(false);
  const [ccProviders, setCcProviders] = useState<CcProvider[]>([]);
  const [ccSelected, setCcSelected] = useState<Set<string>>(new Set());
  const [ccState, setCcState] = useState<'idle' | 'loading' | 'importing' | 'error'>('idle');
  const [ccMessage, setCcMessage] = useState('');

  useEffect(() => {
    if (open) {
      setDrafts(models);
      setSelectedId(models[0]?.id ?? '');
      setCreating(false);
      setImportOpen(false);
      fetch('/api/vault/status')
        .then((response) => response.json())
        .then((data: { refs?: string[] }) => setVaultRefs(data.refs ?? []))
        .catch(() => setVaultRefs([]));
    }
  }, [open, models]);

  if (!open) return null;

  const selected = drafts.find((model) => model.id === selectedId);

  const update = (patch: Partial<ModelDraft>) => {
    if (!selected) return;
    setDrafts((current) =>
      current.map((model) => (model.id === selected.id ? { ...model, ...patch } : model))
    );
  };

  const resetCreate = () => {
    setFetchState('idle');
    setFetchError('');
    setFetchedModels([]);
    setChosen(new Set());
    setFilter('');
    setNewKey('');
    setCreateError('');
  };

  const pickPreset = (key: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.key === key) ?? PROVIDER_PRESETS[0];
    setPresetKey(preset.key);
    setNewLabel(preset.label);
    setNewProvider(preset.provider);
    setNewProtocol(preset.protocol);
    setNewBaseUrl(preset.baseUrl);
    setFetchState('idle');
    setFetchedModels([]);
    setChosen(new Set());
    setFetchError('');
  };

  /** Pull the official catalog straight from the provider with this key. */
  const fetchCatalog = async () => {
    if (!newKey.trim() && !newBaseUrl.trim()) {
      setFetchError('先粘贴 API Key');
      return;
    }
    setFetchState('loading');
    setFetchError('');
    try {
      const response = await fetch('/api/connections/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: newProtocol,
          baseUrl: newBaseUrl,
          apiKey: newKey.trim(),
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        models?: string[];
        error?: string;
      };
      if (!response.ok || !data.ok || !data.models?.length) {
        throw new Error(data.error ?? '没有拿到模型列表');
      }
      setFetchedModels(data.models);
      setChosen(new Set(data.models.slice(0, Math.min(8, data.models.length))));
      setFetchState('ok');
    } catch (error) {
      setFetchState('error');
      setFetchError(error instanceof Error ? error.message : '拉取失败');
    }
  };

  const createConnection = async () => {
    const chosenList = [...chosen];
    if (!chosenList.length) {
      setCreateError('至少勾选一个模型');
      return;
    }
    if (!newBaseUrl.trim()) {
      setCreateError('先填 Base URL');
      return;
    }
    // Known presets own a deterministic ref so live runs can route by model to
    // this key slot; custom endpoints get a random ref. A second connection to
    // the same provider gets a suffixed ref and keeps working through the
    // gateway, just not as the slot default.
    const slotId = presetKey === 'custom' ? '' : `conn-${presetKey}`;
    const taken = slotId ? drafts.some((item) => item.id === slotId) : false;
    const id = taken
      ? `conn-${presetKey}-${crypto.randomUUID().slice(0, 4)}`
      : slotId || `conn-custom-${crypto.randomUUID().slice(0, 6)}`;
    const draft: ModelDraft = {
      id,
      label: newLabel.trim() || '新连接',
      provider: newProvider.trim() || 'Custom',
      protocol: newProtocol,
      baseUrl: newBaseUrl.trim(),
      model: chosenList[0]!,
      models: chosenList,
      apiKey: '',
      status: 'untested',
      tools: ['fs.read'],
      approval: 'always',
      note: '官方模型目录已拉取；key 已存入 Windows DPAPI 保险库。',
    };
    if (newKey.trim()) {
      try {
        const response = await fetch('/api/vault/set', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ref: id, value: newKey.trim() }),
        });
        if (!response.ok) throw new Error('vault save failed');
        setVaultRefs((current) => [...current, id]);
      } catch {
        setCreateError('Key 存入保险库失败，请确认本地服务已启动');
        return;
      }
    }
    setDrafts((current) => [...current, draft]);
    setSelectedId(id);
    setCreating(false);
    resetCreate();
  };

  const openImport = async () => {
    setImportOpen(true);
    setCcState('loading');
    setCcMessage('');
    try {
      const response = await fetch('/api/connections/ccswitch');
      const data = (await response.json()) as { ok?: boolean; providers?: CcProvider[]; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? '读取失败');
      const known = new Set(drafts.map((item) => item.baseUrl));
      setCcProviders(data.providers ?? []);
      setCcSelected(new Set((data.providers ?? []).filter((p) => !known.has(p.baseUrl)).map((p) => p.id)));
      setCcState('idle');
    } catch (error) {
      setCcState('error');
      setCcMessage(error instanceof Error ? error.message : '读取 CC Switch 失败');
    }
  };

  const importFromCc = async () => {
    setCcState('importing');
    try {
      const response = await fetch('/api/connections/ccswitch/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...ccSelected] }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        imported?: ModelDraft[];
        failed?: string[];
        error?: string;
      };
      if (!response.ok || !data.ok) throw new Error(data.error ?? '导入失败');
      const imported = (data.imported ?? []).map((item) => ({ ...item, apiKey: '' }));
      setDrafts((current) => [...current, ...imported]);
      setVaultRefs((current) => [...current, ...imported.map((item) => item.id)]);
      setImportOpen(false);
      setCcState('idle');
      if (imported[0]) setSelectedId(imported[0].id);
    } catch (error) {
      setCcState('error');
      setCcMessage(error instanceof Error ? error.message : '导入失败');
    }
  };

  /** Refresh the catalog of an existing connection from the provider itself. */
  const refreshCatalog = async (draft: ModelDraft) => {
    update({ status: 'testing' });
    try {
      const response = await fetch('/api/connections/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          connectionId: draft.id,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; models?: string[]; error?: string };
      if (!response.ok || !data.ok || !data.models?.length) {
        throw new Error(data.error ?? '没有拿到模型列表');
      }
      const merged = [...new Set([...data.models, ...catalogOf(draft)])];
      update({
        models: merged,
        status: 'ok',
        note: `官方模型目录已更新（${merged.length} 个）`,
      });
    } catch (error) {
      update({
        status: 'fail',
        note: error instanceof Error ? error.message : '拉取模型失败',
      });
    }
  };

  /** Pull every configured key's real catalog in one go. */
  const refreshAllCatalogs = async () => {
    setRefreshing(true);
    setRefreshNote('');
    try {
      const response = await fetch('/api/models/refresh', { method: 'POST' });
      const data = (await response.json()) as {
        ok?: boolean;
        catalogs?: Record<string, { models?: string[]; baseUrl?: string }>;
        error?: string;
      };
      if (!response.ok || !data.ok) throw new Error(data.error ?? '刷新失败');
      const catalogs = data.catalogs ?? {};
      const hostOf = (url: string) => {
        try {
          return new URL(url).host;
        } catch {
          return url;
        }
      };
      // The cache is keyed by key-slot ref; a connection may use a different id
      // for the same provider, so fall back to matching the host.
      const cachedFor = (draft: ModelDraft) =>
        catalogs[draft.id] ??
        catalogs[draft.baseUrl] ??
        Object.values(catalogs).find((entry) => hostOf(entry.baseUrl ?? '') === hostOf(draft.baseUrl));
      let updated = 0;
      setDrafts((current) =>
        current.map((draft) => {
          const cached = cachedFor(draft);
          if (!cached?.models?.length) return draft;
          updated += 1;
          const models = [...new Set([...cached.models, ...catalogOf(draft)])];
          return {
            ...draft,
            models,
            model: models.includes(draft.model) ? draft.model : preferredModel(models),
            note: `官方目录已更新（${cached.models.length} 个模型）`,
          };
        })
      );
      setRefreshNote(`已更新 ${updated} 个连接`);
    } catch (error) {
      setRefreshNote(error instanceof Error ? error.message : '刷新失败');
    } finally {
      setRefreshing(false);
    }
  };

  const testConnection = async () => {
    if (!selected) return;
    update({ status: 'testing', latencyMs: undefined });
    try {
      const response = await fetch('/api/connections/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectionId: selected.id,
          protocol: selected.protocol,
          baseUrl: selected.baseUrl,
          model: selected.model,
          apiKey: selected.apiKey,
        }),
      });
      const result = (await response.json()) as {
        ok?: boolean;
        latencyMs?: number;
        error?: string;
      };
      update({
        status: result.ok ? 'ok' : 'fail',
        latencyMs: result.latencyMs,
        note: result.ok ? selected.note : result.error ?? '连接失败',
      });
    } catch {
      update({
        status: 'fail',
        latencyMs: undefined,
        note: '本地服务未启动，或请求失败。先运行 npm run dev。',
      });
    }
  };

  const saveToVault = async () => {
    if (!selected) return;
    const value = selected.apiKey.trim();
    if (!value) return;
    try {
      const response = await fetch('/api/vault/set', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: selected.id, value }),
      });
      if (!response.ok) throw new Error('vault save failed');
      update({
        apiKey: '',
        note: '已存入 Windows DPAPI 保险库；测试与运行会自动读取。',
      });
      setVaultRefs((current) =>
        current.includes(selected.id) ? current : [...current, selected.id]
      );
    } catch {
      update({ note: '保存到保险库失败，请确认本地服务已启动。' });
    }
  };

  const toggleTool = (tool: ToolCapability) => {
    if (!selected) return;
    const tools = selected.tools.includes(tool)
      ? selected.tools.filter((item) => item !== tool)
      : [...selected.tools, tool];
    update({ tools });
  };

  const risky = selected?.tools.some((tool) => toolLabels[tool]?.risky) ?? false;
  const visibleFetched = fetchedModels.filter((model) =>
    filter.trim() ? model.toLowerCase().includes(filter.trim().toLowerCase()) : true
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="模型管理"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title">模型连接</div>
            <div className="modal-sub">
              先给 Key，再自动拉取它能调用的官方模型 · Key 只进保险库
            </div>
          </div>
          <button className="btn ghost" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <button
              className="mini-btn"
              onClick={() => void refreshAllCatalogs()}
              disabled={refreshing}
              title="从每个已配置的 Key 拉取官方模型目录"
            >
              {refreshing ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
              {refreshing ? '刷新中…' : '刷新全部目录'}
            </button>
            {onApplyPreferred && (
              <button
                className="mini-btn"
                onClick={() => onApplyPreferred(drafts)}
                title="每个节点换成它那把 Key 里最便宜/最快的一档"
              >
                把画布节点换成推荐模型
              </button>
            )}
            {refreshNote && <span className="field-hint">{refreshNote}</span>}
          </div>
          <div className="model-list">
            {drafts.map((model) => (
              <button
                key={model.id}
                className={`model-item ${model.id === selectedId && !creating ? 'active' : ''}`}
                onClick={() => {
                  setCreating(false);
                  setSelectedId(model.id);
                }}
              >
                <span className="model-item-name">{model.label}</span>
                <span className={`model-item-status ${model.status}`}>
                  {statusText[model.status]}
                </span>
              </button>
            ))}
            <button
              className="model-add"
              onClick={() => {
                setCreating(true);
                setSelectedId('');
                resetCreate();
                pickPreset(PROVIDER_PRESETS[0].key);
              }}
            >
              <Plus size={12} /> 新连接
            </button>
            <button className="model-add" onClick={openImport}>
              <Download size={12} /> 从 CC Switch 导入
            </button>
          </div>

          {creating && (
            <div className="model-form">
              <div className="section-label">1 · 选择供应商</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                {PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.key}
                    className={`btn ${presetKey === preset.key ? 'primary' : 'ghost'}`}
                    onClick={() => pickPreset(preset.key)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <div className="field">
                <label>Base URL</label>
                <input
                  value={newBaseUrl}
                  onChange={(event) => setNewBaseUrl(event.target.value)}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>

              <div className="field">
                <label>2 · 粘贴 API Key</label>
                <input
                  type="password"
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder="粘贴后点「拉取官方模型」"
                  autoComplete="off"
                />
                <div className="field-hint">
                  先给 Key，再自动列出它能调用的官方模型；Key 只写入 Windows DPAPI 保险库。
                </div>
              </div>

              <div className="probe-row">
                <button
                  className="btn"
                  onClick={fetchCatalog}
                  disabled={fetchState === 'loading' || !newKey.trim()}
                >
                  {fetchState === 'loading' ? (
                    <RefreshCw size={13} className="spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  {fetchState === 'loading' ? '拉取中…' : '拉取官方模型'}
                </button>
                {fetchState === 'ok' && (
                  <span className="probe-result ok">
                    <Check size={12} /> 拿到 {fetchedModels.length} 个模型
                  </span>
                )}
                {fetchState === 'error' && (
                  <span className="probe-result fail">{fetchError}</span>
                )}
              </div>

              {fetchState === 'ok' && (
                <>
                  <div className="section-label">3 · 选择要纳入目录的模型</div>
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="筛选模型…"
                    style={{ width: '100%', marginBottom: 6 }}
                  />
                  <div
                    style={{
                      maxHeight: 180,
                      overflow: 'auto',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: 6,
                    }}
                  >
                    {visibleFetched.map((model) => (
                      <label key={model} className="tool-item" style={{ display: 'flex', gap: 6 }}>
                        <input
                          type="checkbox"
                          checked={chosen.has(model)}
                          onChange={() =>
                            setChosen((current) => {
                              const next = new Set(current);
                              if (next.has(model)) next.delete(model);
                              else next.add(model);
                              return next;
                            })
                          }
                        />
                        <span>{model}</span>
                      </label>
                    ))}
                    {!visibleFetched.length && (
                      <div className="field-hint">没有匹配的模型</div>
                    )}
                  </div>
                  <div className="probe-row">
                    <button
                      className="mini-btn"
                      onClick={() => setChosen(new Set(visibleFetched))}
                    >
                      全选当前
                    </button>
                    <button className="mini-btn" onClick={() => setChosen(new Set())}>
                      清空
                    </button>
                    <span className="field-hint">已选 {chosen.size} 个</span>
                  </div>
                </>
              )}

              <div className="field" style={{ marginTop: 10 }}>
                <label>连接名称</label>
                <input value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
              </div>

              {createError && <div className="field-hint" style={{ color: '#f87171' }}>{createError}</div>}

              <div className="probe-row">
                <button className="btn primary" onClick={createConnection} disabled={!chosen.size}>
                  <Plus size={13} /> 添加连接
                </button>
                <button className="btn ghost" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
            </div>
          )}

          {!creating && selected && (
            <div className="model-form">
              <div className="field">
                <label>显示名</label>
                <input
                  value={selected.label}
                  onChange={(event) => update({ label: event.target.value })}
                  placeholder="例如：写手 · MiniMax"
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Provider</label>
                  <input
                    value={selected.provider}
                    onChange={(event) => update({ provider: event.target.value })}
                  />
                </div>
                <div className="field">
                  <label>协议</label>
                  <select
                    value={selected.protocol}
                    onChange={(event) =>
                      update({ protocol: event.target.value as ModelDraft['protocol'] })
                    }
                  >
                    <option value="openai-chat">openai-chat</option>
                    <option value="anthropic-messages">anthropic-messages</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Base URL</label>
                <input
                  value={selected.baseUrl}
                  onChange={(event) => update({ baseUrl: event.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>

              <div className="field">
                <label>主模型（节点默认用它）</label>
                <select
                  value={selected.model}
                  onChange={(event) => update({ model: event.target.value })}
                >
                  {catalogOf(selected).map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                  {selected.model && !catalogOf(selected).includes(selected.model) && (
                    <option value={selected.model}>{selected.model}（不在目录里）</option>
                  )}
                </select>
              </div>

              <div className="field">
                <label>该 Key 可调用的模型目录（每行一个）</label>
                <textarea
                  value={(selected.models ?? catalogOf(selected)).join('\n')}
                  onChange={(event) => {
                    const models = event.target.value
                      .split(/\r?\n|,/)
                      .map((item) => item.trim())
                      .filter(Boolean);
                    update({
                      models,
                      model: models.includes(selected.model) ? selected.model : (models[0] ?? ''),
                    });
                  }}
                  placeholder={'deepseek-reasoner\ndeepseek-chat'}
                  rows={4}
                />
                <button
                  className="mini-btn"
                  style={{ marginTop: 6 }}
                  onClick={() => void refreshCatalog(selected)}
                >
                  <Download size={12} /> 从供应商拉取官方模型
                </button>
              </div>

              <div className="field">
                <label>API Key</label>
                <input
                  type="password"
                  value={selected.apiKey}
                  onChange={(event) => update({ apiKey: event.target.value })}
                  placeholder="写入 OS 密钥链；不会写进仓库、日志或导出"
                  autoComplete="off"
                />
              </div>

              <div className="probe-row">
                <button className="btn" onClick={testConnection} disabled={selected.status === 'testing'}>
                  <FlaskConical size={13} /> 测试连接
                </button>
                <button
                  className="mini-btn"
                  onClick={saveToVault}
                  disabled={!selected.apiKey.trim()}
                  title="加密存入 Windows DPAPI，仅当前用户可解密"
                >
                  <ShieldCheck size={12} /> 存入保险库
                </button>
                <span className={`probe-result ${selected.status}`}>
                  {selected.status === 'ok' && <Check size={12} />}
                  {statusText[selected.status]}
                  {selected.status === 'ok' && selected.latencyMs
                    ? ` · ${selected.latencyMs}ms`
                    : ''}
                </span>
                {vaultRefs.includes(selected.id) && (
                  <span className="vault-badge">
                    <ShieldCheck size={11} /> 已存保险库
                  </span>
                )}
              </div>
              <div className="field-hint">
                测试由本地服务发一次最小真实请求，检查可达性、流式首 token 与 usage，并返回真实延迟。Key 只在本次请求中使用，不写入浏览器存储、日志或导出。
              </div>

              <div className="section-label">工具与权限</div>
              <div className="tool-grid">
                {toolKeys.map((tool) => (
                  <label key={tool} className="tool-item">
                    <input
                      type="checkbox"
                      checked={selected.tools.includes(tool)}
                      onChange={() => toggleTool(tool)}
                    />
                    <span>
                      {toolLabels[tool].label}
                      <small>{toolLabels[tool].hint}</small>
                    </span>
                  </label>
                ))}
              </div>

              <div className="field" style={{ marginTop: 12 }}>
                <label>危险动作审批</label>
                <select
                  value={selected.approval}
                  onChange={(event) =>
                    update({ approval: event.target.value as ModelDraft['approval'] })
                  }
                >
                  <option value="always">每次都问我</option>
                  <option value="per-run">每次运行问一次</option>
                  <option value="auto">自动执行（仅限只读工具）</option>
                </select>
              </div>

              {risky && (
                <div className="warning">
                  <ShieldAlert size={14} />
                  <span>
                    Shell / 屏幕控制默认不应开启。启用前必须有 WSL2 或 Docker 沙箱、命令白名单、可见录制与急停。
                  </span>
                </div>
              )}

              {selected.note && <div className="field-hint">{selected.note}</div>}
            </div>
          )}

          {importOpen && (
            <div className="model-form">
              <div className="section-label">从 CC Switch 导入供应商</div>
              {ccState === 'loading' && <div className="field-hint">读取中…</div>}
              {ccState === 'error' && <div className="probe-result fail">{ccMessage}</div>}
              {ccState !== 'loading' && (
                <>
                  {ccProviders.map((provider) => (
                    <label key={provider.id} className="tool-item" style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="checkbox"
                        checked={ccSelected.has(provider.id)}
                        onChange={() =>
                          setCcSelected((current) => {
                            const next = new Set(current);
                            if (next.has(provider.id)) next.delete(provider.id);
                            else next.add(provider.id);
                            return next;
                          })
                        }
                      />
                      <span>
                        {provider.name}
                        <small>{provider.baseUrl}</small>
                      </span>
                    </label>
                  ))}
                  {!ccProviders.length && (
                    <div className="field-hint">没有读到可导入的供应商（需要 CC Switch 里已保存 Key）。</div>
                  )}
                  <div className="probe-row">
                    <button
                      className="btn primary"
                      onClick={() => void importFromCc()}
                      disabled={!ccSelected.size || ccState === 'importing'}
                    >
                      <Download size={13} /> {ccState === 'importing' ? '导入中…' : '导入所选'}
                    </button>
                    <button className="btn ghost" onClick={() => setImportOpen(false)}>
                      取消
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="modal-foot-hint">
            身份与能力分离：改连接会影响引用它的节点；节点可单独选该 Key 下的任意模型。
          </span>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onChange(drafts);
              onClose();
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
