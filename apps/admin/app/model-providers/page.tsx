"use client";

import type { ModelProvider, ModelProviderPayload } from "@homelab/views";
import { FormEvent, useEffect, useState } from "react";
import { AuthShell } from "../components/auth-shell";
import { api } from "../lib/api";

const providerTypeLabel = "OpenAI-compatible";

type DialogPayload = ModelProviderPayload & { apiKey?: string };

export default function ModelProvidersPage() {
  const [items, setItems] = useState<ModelProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setItems(await api.listModelProviders());
    } catch {
      setError("模型提供方列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function runRowAction(provider: ModelProvider, action: () => Promise<void>) {
    setBusyId(provider.id);
    setError("");
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败，请重试");
    } finally {
      setBusyId("");
    }
  }

  return (
    <AuthShell>
      <section className="page-header">
        <div>
          <p className="eyebrow">Model Providers</p>
          <h2>模型提供方</h2>
        </div>
        <button onClick={() => setCreateOpen(true)} type="button">
          新增 Provider
        </button>
      </section>

      {error ? <div className="notice error">{error}</div> : null}
      {loading ? <div className="notice">加载中...</div> : null}
      {!loading && items.length === 0 ? (
        <div className="empty-state empty-action">
          <div>
            <strong>暂无模型提供方</strong>
            <p>新增 OpenAI-compatible Provider 后可设置全局默认模型服务。</p>
          </div>
          <button onClick={() => setCreateOpen(true)} type="button">
            新增 Provider
          </button>
        </div>
      ) : null}
      {!loading && items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>Base URL</th>
                <th>默认模型</th>
                <th>API Key</th>
                <th>状态</th>
                <th>默认</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((provider) => (
                <tr key={provider.id}>
                  <td data-label="名称">{provider.name}</td>
                  <td data-label="类型">{formatProviderType(provider.type)}</td>
                  <td data-label="Base URL">{provider.baseUrl}</td>
                  <td data-label="默认模型">{provider.defaultModel}</td>
                  <td data-label="API Key">
                    <span className="masked-key">{provider.hasApiKey ? "******** 已配置" : "未配置"}</span>
                  </td>
                  <td data-label="状态">
                    <span className={provider.isActive ? "status on" : "status off"}>
                      {provider.isActive ? "启用" : "禁用"}
                    </span>
                  </td>
                  <td data-label="默认">
                    <span className={provider.isDefault ? "status on" : "status off"}>
                      {provider.isDefault ? "是" : "否"}
                    </span>
                  </td>
                  <td className="actions" data-label="操作">
                    <button onClick={() => setEditing(provider)} type="button">
                      编辑
                    </button>
                    <button
                      disabled={!provider.isActive || provider.isDefault || busyId === provider.id}
                      onClick={() =>
                        runRowAction(provider, async () => {
                          await api.setDefaultModelProvider(provider.id);
                        })
                      }
                      type="button"
                    >
                      设为默认
                    </button>
                    <button
                      disabled={provider.isDefault || busyId === provider.id}
                      onClick={() =>
                        runRowAction(provider, async () => {
                          if (provider.isActive) {
                            await api.disableModelProvider(provider.id);
                          } else {
                            await api.enableModelProvider(provider.id);
                          }
                        })
                      }
                      type="button"
                    >
                      {provider.isActive ? "禁用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {createOpen ? (
        <ProviderDialog
          title="新增 Provider"
          onClose={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            await api.createModelProvider({
              ...payload,
              apiKey: payload.apiKey ?? ""
            });
            setCreateOpen(false);
            await load();
          }}
        />
      ) : null}
      {editing ? (
        <ProviderDialog
          title="编辑 Provider"
          provider={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (payload) => {
            const updatePayload: Partial<ModelProviderPayload> = {
              name: payload.name,
              type: payload.type,
              baseUrl: payload.baseUrl,
              defaultModel: payload.defaultModel,
              isActive: payload.isActive
            };
            if (payload.apiKey?.trim()) {
              updatePayload.apiKey = payload.apiKey.trim();
            }
            await api.updateModelProvider(editing.id, updatePayload);
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </AuthShell>
  );
}

function ProviderDialog({
  title,
  provider,
  onClose,
  onSubmit
}: {
  title: string;
  provider?: ModelProvider;
  onClose: () => void;
  onSubmit: (payload: DialogPayload) => Promise<void>;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState(provider?.defaultModel ?? "");
  const [isActive, setIsActive] = useState(provider?.isActive ?? true);
  const [error, setError] = useState("");
  const [testStatus, setTestStatus] = useState(provider ? "未测试" : "未测试");
  const [testing, setTesting] = useState(false);

  const canUseSavedKey = Boolean(provider?.id && provider.hasApiKey && !apiKey.trim());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const validationError = validateForm({ name, baseUrl, apiKey, defaultModel, editing: Boolean(provider) });
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      await onSubmit({
        name: name.trim(),
        type: "OPENAI_COMPATIBLE",
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        defaultModel: defaultModel.trim(),
        isActive
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败，请重试");
    }
  }

  async function testConnection() {
    setError("");
    setTestStatus("测试中...");
    setTesting(true);

    const validationError = validateConnection({ baseUrl, apiKey, defaultModel, canUseSavedKey });
    if (validationError) {
      setTestStatus("未测试");
      setTesting(false);
      setError(validationError);
      return;
    }

    try {
      const result = await api.testModelProviderConnection(
        canUseSavedKey
          ? { providerId: provider?.id ?? "" }
          : {
              baseUrl: baseUrl.trim(),
              apiKey: apiKey.trim(),
              defaultModel: defaultModel.trim()
            }
      );
      setTestStatus(result.ok ? "测试成功" : `测试失败：${result.error ?? "请检查配置"}`);
    } catch (caught) {
      setTestStatus(caught instanceof Error ? `测试失败：${caught.message}` : "测试连接失败，请稍后重试");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal provider-modal" onSubmit={submit}>
        <h3>{title}</h3>
        <label>
          名称
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          类型
          <select value="OPENAI_COMPATIBLE" disabled>
            <option value="OPENAI_COMPATIBLE">{providerTypeLabel}</option>
          </select>
        </label>
        <label>
          Base URL
          <input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
          />
        </label>
        <label>
          API Key
          <input
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={provider?.hasApiKey ? "******** 已配置 / 输入新 Key" : "输入 API Key"}
            type="password"
          />
        </label>
        <label>
          默认模型
          <input
            value={defaultModel}
            onChange={(event) => setDefaultModel(event.target.value)}
            placeholder="gpt-4.1-mini"
          />
        </label>
        <label className="check-row">
          <input checked={isActive} onChange={(event) => setIsActive(event.target.checked)} type="checkbox" />
          启用 Provider
        </label>
        <div className="connection-row">
          <button disabled={testing} onClick={testConnection} type="button">
            测试连接
          </button>
          <span className={testStatus.startsWith("测试失败") ? "connection-result error-text" : "connection-result"}>
            {testStatus}
          </span>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="submit">保存</button>
        </div>
      </form>
    </div>
  );
}

function validateForm({
  name,
  baseUrl,
  apiKey,
  defaultModel,
  editing
}: {
  name: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  editing: boolean;
}) {
  if (!name.trim()) {
    return "名称必填";
  }
  const urlError = validateHttpUrl(baseUrl);
  if (urlError) {
    return urlError;
  }
  if (!editing && !apiKey.trim()) {
    return "API Key 必填";
  }
  if (!defaultModel.trim()) {
    return "默认模型必填";
  }
  return "";
}

function validateConnection({
  baseUrl,
  apiKey,
  defaultModel,
  canUseSavedKey
}: {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  canUseSavedKey: boolean;
}) {
  const urlError = validateHttpUrl(baseUrl);
  if (urlError) {
    return urlError;
  }
  if (!canUseSavedKey && !apiKey.trim()) {
    return "请先填写 API Key";
  }
  if (!defaultModel.trim()) {
    return "请先填写默认模型";
  }
  return "";
}

function validateHttpUrl(value: string) {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? "" : "请输入合法的 HTTP/HTTPS Base URL";
  } catch {
    return "请输入合法的 HTTP/HTTPS Base URL";
  }
}

function formatProviderType(type: ModelProvider["type"]) {
  return type === "OPENAI_COMPATIBLE" ? providerTypeLabel : type;
}
