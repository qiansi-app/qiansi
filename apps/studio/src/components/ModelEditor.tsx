import { useEffect, useState } from 'react';
import type { ToolCapability } from '@qiansi/engine';
import { Check, FlaskConical, Plus, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { initialModels, toolLabels, type ConnectionStatus, type ModelDraft } from '../data/models';

interface ModelEditorProps {
  open: boolean;
  models: ModelDraft[];
  onChange: (models: ModelDraft[]) => void;
  onClose: () => void;
}

const statusText: Record<ConnectionStatus, string> = {
  untested: '未测试',
  testing: '测试中…',
  ok: '连通',
  fail: '失败',
};

const toolKeys = Object.keys(toolLabels) as ToolCapability[];

export function ModelEditor({ open, models, onChange, onClose }: ModelEditorProps) {
  const [drafts, setDrafts] = useState<ModelDraft[]>(models);
  const [selectedId, setSelectedId] = useState(models[0]?.id ?? '');
  const [vaultRefs, setVaultRefs] = useState<string[]>([]);

  useEffect(() => {
    if (open) {
      setDrafts(models);
      setSelectedId(models[0]?.id ?? '');
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

  const addModel = () => {
    const id = `conn-${crypto.randomUUID().slice(0, 6)}`;
    const next: ModelDraft = {
      ...initialModels[0]!,
      id,
      label: '新模型连接',
      provider: 'Custom',
      baseUrl: 'https://api.example.com/v1',
      model: '',
      apiKey: '',
      status: 'untested',
      tools: ['fs.read'],
      note: undefined,
    };
    setDrafts((current) => [...current, next]);
    setSelectedId(id);
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
              身份可编辑 · Key 只进保险库 · 连接前先做首连探测
            </div>
          </div>
          <button className="btn ghost" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="modal-body">
          <div className="model-list">
            {drafts.map((model) => (
              <button
                key={model.id}
                className={`model-item ${model.id === selectedId ? 'active' : ''}`}
                onClick={() => setSelectedId(model.id)}
              >
                <span className="model-item-name">{model.label}</span>
                <span className={`model-item-status ${model.status}`}>
                  {statusText[model.status]}
                </span>
              </button>
            ))}
            <button className="model-add" onClick={addModel}>
              <Plus size={12} /> 新连接
            </button>
          </div>

          {selected && (
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
                <label>Model ID</label>
                <input
                  value={selected.model}
                  onChange={(event) => update({ model: event.target.value })}
                  placeholder="deepseek-reasoner"
                />
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
        </div>

        <div className="modal-foot">
          <span className="modal-foot-hint">身份与能力分离：改连接会影响引用它的节点。</span>
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
