import { useRef, useState } from 'react';
import { FolderOpen, Loader2, Paperclip, Sparkles, X } from 'lucide-react';
import type { LibraryFile } from '../data/demoGraph';
import type { ModelDraft } from '../data/models';

export interface WorkflowNodePlan {
  id: string;
  name: string;
  role: string;
  connectionId: string;
  effort: string;
}

export interface WorkflowEdgePlan {
  id?: string;
  source: string;
  target: string;
  kind: string;
  label?: string;
}

export interface WorkflowPlan {
  summary: string;
  nodes: WorkflowNodePlan[];
  edges: WorkflowEdgePlan[];
}

interface WorkflowModalProps {
  open: boolean;
  models: ModelDraft[];
  onClose: () => void;
  onUploadFiles: (files: File[]) => Promise<LibraryFile[]>;
  onApply: (plan: WorkflowPlan, files: LibraryFile[], orchestratorId: string) => void;
}

export function WorkflowModal({
  open,
  models,
  onClose,
  onUploadFiles,
  onApply,
}: WorkflowModalProps) {
  const [goal, setGoal] = useState('');
  const [orchestratorId, setOrchestratorId] = useState(models[0]?.id ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(models.map((model) => model.id))
  );
  const [files, setFiles] = useState<File[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  const toggleModel = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setFiles((current) => [...current, ...Array.from(incoming)].slice(0, 40));
  };

  const generate = async () => {
    const text = goal.trim();
    if (!text || running) return;
    const orchestrator = models.find((model) => model.id === orchestratorId);
    if (!orchestrator) {
      setError('请选择一个主控模型');
      return;
    }
    const workers = models.filter(
      (model) => selected.has(model.id) && model.id !== orchestratorId
    );
    if (workers.length === 0) {
      setError('至少选择一个工作模型');
      return;
    }

    setRunning(true);
    setError(null);
    try {
      const uploaded = files.length > 0 ? await onUploadFiles(files) : [];
      const response = await fetch('/api/workflow', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: text,
          orchestrator: {
            connectionId: orchestrator.id,
            protocol: orchestrator.protocol,
            baseUrl: orchestrator.baseUrl,
            model: orchestrator.model,
          },
          models: workers.map((model) => ({
            connectionId: model.id,
            name: model.label,
            provider: model.provider,
            model: model.model,
            effort: 'medium',
          })),
          files: uploaded.map((file) => ({ name: file.name, preview: file.preview })),
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        workflow?: WorkflowPlan;
        error?: string;
      };
      if (!response.ok || !data.ok || !data.workflow) {
        throw new Error(data.error ?? 'workflow_failed');
      }
      onApply(data.workflow, uploaded, orchestratorId);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成工作流失败');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="workflow-modal" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2 className="workflow-title">
              <Sparkles size={16} /> 一键生成工作流
            </h2>
            <p className="workflow-sub">
              描述任务、选主控和工作模型，主控会自动拆解并连好画布
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="workflow-body">
          <div className="workflow-field">
            <label>任务目标</label>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="例如：研究多 AI 协作的现状，写一篇 800 字科普，并附来源与事实核对"
              rows={4}
            />
          </div>

          <div className="workflow-grid">
            <div className="workflow-field">
              <label>主控模型</label>
              <select
                value={orchestratorId}
                onChange={(event) => setOrchestratorId(event.target.value)}
              >
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} · {model.model}
                  </option>
                ))}
              </select>
              <div className="workflow-hint">负责拆解、分派与验收</div>
            </div>

            <div className="workflow-field">
              <label>工作模型（{selected.size}）</label>
              <div className="workflow-models">
                {models
                  .filter((model) => model.id !== orchestratorId)
                  .map((model) => (
                    <label key={model.id} className="workflow-model">
                      <input
                        type="checkbox"
                        checked={selected.has(model.id)}
                        onChange={() => toggleModel(model.id)}
                      />
                      <span>{model.label}</span>
                      <small>{model.model}</small>
                    </label>
                  ))}
              </div>
            </div>
          </div>

          <div className="workflow-field">
            <label>文件与文件夹（可选）</label>
            <div className="workflow-files">
              <button
                className="btn ghost"
                onClick={() => fileInput.current?.click()}
                type="button"
              >
                <Paperclip size={13} /> 添加文件
              </button>
              <button
                className="btn ghost"
                onClick={() => folderInput.current?.click()}
                type="button"
              >
                <FolderOpen size={13} /> 添加文件夹
              </button>
              <span className="workflow-hint">
                {files.length > 0 ? `${files.length} 个文件` : '会放进公共文件库并参与规划'}
              </span>
            </div>
            {files.length > 0 && (
              <div className="workflow-file-list">
                {files.slice(0, 8).map((file, index) => (
                  <span key={`${file.name}-${index}`} className="workflow-file">
                    {(file as File & { webkitRelativePath?: string }).webkitRelativePath ||
                      file.name}
                    <button
                      type="button"
                      onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {files.length > 8 && <span className="workflow-hint">…</span>}
              </div>
            )}
          </div>

          {error && <div className="workflow-error">{error}</div>}
        </div>

        <footer className="workflow-foot">
          <div className="workflow-hint">
            生成后会替换当前画布；模型连接、设置和已有文件不会删除。
          </div>
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => void generate()} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {running ? '主控规划中…' : '生成工作流'}
          </button>
        </footer>

        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
        <input
          ref={(element) => {
            folderInput.current = element;
            element?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
