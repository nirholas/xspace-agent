// settings.js — Settings page

export class SettingsPage {
  constructor(container, app) {
    this.app = app
    this.container = container
    this.render()
    this.bind()
  }

  render() {
    this.container.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h1 class="page-title">Settings</h1>
          <p class="page-subtitle">Server configuration and API keys</p>
        </div>

        <div class="card-grid card-grid-2">
          <!-- Authentication -->
          <div class="card">
            <div class="card-header"><span class="card-title">X Authentication</span></div>
            <div class="form-group">
              <label class="form-label">Auth Method</label>
              <select class="select" id="settings-auth-method">
                <option value="cookie">Cookie Auth (recommended)</option>
                <option value="credentials">Username / Password</option>
              </select>
            </div>
            <div id="settings-cookie-fields">
              <div class="form-group">
                <label class="form-label">Auth Token</label>
                <input type="password" class="input" id="settings-auth-token" placeholder="Your X auth_token cookie" />
              </div>
              <div class="form-group">
                <label class="form-label">CT0 Token</label>
                <input type="password" class="input" id="settings-ct0" placeholder="Your X ct0 cookie" />
              </div>
            </div>
            <div id="settings-cred-fields" style="display:none">
              <div class="form-group">
                <label class="form-label">Username</label>
                <input type="text" class="input" id="settings-username" placeholder="@username" />
              </div>
              <div class="form-group">
                <label class="form-label">Password</label>
                <input type="password" class="input" id="settings-password" placeholder="Password" />
              </div>
            </div>
            <div class="form-hint" style="margin-bottom:var(--space-md)">
              Credentials are sent to the server and used for browser authentication only. They are not stored permanently.
            </div>
          </div>

          <!-- API Keys -->
          <div class="card">
            <div class="card-header"><span class="card-title">API Keys</span></div>
            <div class="form-group">
              <label class="form-label">OpenAI API Key</label>
              <input type="password" class="input" id="settings-openai-key" placeholder="sk-..." />
            </div>
            <div class="form-group">
              <label class="form-label">Anthropic API Key</label>
              <input type="password" class="input" id="settings-anthropic-key" placeholder="sk-ant-..." />
            </div>
            <div class="form-group">
              <label class="form-label">Groq API Key</label>
              <input type="password" class="input" id="settings-groq-key" placeholder="gsk_..." />
            </div>
            <div class="form-group">
              <label class="form-label">ElevenLabs API Key</label>
              <input type="password" class="input" id="settings-elevenlabs-key" placeholder="..." />
            </div>
            <div class="form-hint">
              API keys are stored in server memory only. Set via environment variables for persistence.
            </div>
          </div>
        </div>

        <!-- Behavior Settings -->
        <div class="card" style="margin-top:var(--space-md)">
          <div class="card-header"><span class="card-title">Behavior</span></div>
          <div class="card-grid card-grid-3">
            <div class="form-group">
              <label class="form-label">AI Provider</label>
              <select class="select" id="settings-ai-provider">
                <option value="openai">OpenAI</option>
                <option value="openai-chat">OpenAI Chat</option>
                <option value="claude">Claude</option>
                <option value="groq">Groq</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">STT Provider</label>
              <select class="select" id="settings-stt-provider">
                <option value="groq">Groq Whisper</option>
                <option value="openai">OpenAI Whisper</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">TTS Provider</label>
              <select class="select" id="settings-tts-provider">
                <option value="elevenlabs">ElevenLabs</option>
                <option value="openai">OpenAI TTS</option>
                <option value="browser">Browser</option>
              </select>
            </div>
          </div>

          <div class="divider"></div>

          <div style="display:flex;flex-wrap:wrap;gap:var(--space-lg)">
            <div style="display:flex;align-items:center;gap:var(--space-sm)">
              <label class="toggle">
                <input type="checkbox" id="settings-headless" checked />
                <span class="toggle-slider"></span>
              </label>
              <span class="form-label" style="margin:0;text-transform:none;letter-spacing:0">Headless Browser</span>
            </div>
            <div style="display:flex;align-items:center;gap:var(--space-sm)">
              <label class="toggle">
                <input type="checkbox" id="settings-auto-join" />
                <span class="toggle-slider"></span>
              </label>
              <span class="form-label" style="margin:0;text-transform:none;letter-spacing:0">Auto-join on Start</span>
            </div>
          </div>
        </div>

        <!-- Server Info -->
        <div class="card" style="margin-top:var(--space-md)">
          <div class="card-header"><span class="card-title">Server Info</span></div>
          <ul class="kv-list" id="settings-server-info">
            <li class="kv-item"><span class="kv-key">Version</span><span class="kv-value">--</span></li>
            <li class="kv-item"><span class="kv-key">Node.js</span><span class="kv-value">--</span></li>
            <li class="kv-item"><span class="kv-key">Uptime</span><span class="kv-value">--</span></li>
            <li class="kv-item"><span class="kv-key">Agent Status</span><span class="kv-value">--</span></li>
          </ul>
          <div class="btn-row" style="margin-top:var(--space-md)">
            <button class="btn" id="settings-btn-health">Check Health</button>
            <button class="btn" id="settings-btn-providers">Provider Status</button>
          </div>
        </div>
      </div>
    `
  }

  bind() {
    const $ = id => document.getElementById(id)

    // Auth method toggle
    $('settings-auth-method')?.addEventListener('change', (e) => {
      const isCookie = e.target.value === 'cookie'
      $('settings-cookie-fields').style.display = isCookie ? 'block' : 'none'
      $('settings-cred-fields').style.display = isCookie ? 'none' : 'block'
    })

    // Health check
    $('settings-btn-health')?.addEventListener('click', async () => {
      try {
        const res = await fetch('/health')
        const data = await res.json()
        const list = $('settings-server-info')
        if (list) {
          list.innerHTML = `
            <li class="kv-item"><span class="kv-key">Status</span><span class="kv-value">${data.status || '--'}</span></li>
            <li class="kv-item"><span class="kv-key">Uptime</span><span class="kv-value">${this._formatUptime(data.uptime)}</span></li>
            <li class="kv-item"><span class="kv-key">Agent</span><span class="kv-value">${data.agent || '--'}</span></li>
            <li class="kv-item"><span class="kv-key">Timestamp</span><span class="kv-value">${data.timestamp || '--'}</span></li>
            ${data.database ? `<li class="kv-item"><span class="kv-key">Database</span><span class="kv-value">${data.database.ok ? 'OK' : 'Error'}</span></li>` : ''}
          `
        }
        this.app.log('Health check: ' + data.status, data.status === 'ok' ? 'ok' : 'warn')
      } catch (err) {
        this.app.log('Health check failed: ' + err.message, 'err')
      }
    })

    // Provider status
    $('settings-btn-providers')?.addEventListener('click', async () => {
      try {
        const apiKey = this.app.state.apiKey
        const headers = apiKey ? { 'X-API-Key': apiKey } : {}
        const res = await fetch('/admin/providers', { headers })
        if (res.status === 401) {
          this.app.log('Provider status requires ADMIN_API_KEY', 'err')
          return
        }
        const data = await res.json()
        this.app.log('Providers: ' + JSON.stringify(data).slice(0, 200), 'info')
      } catch (err) {
        this.app.log('Provider check failed: ' + err.message, 'err')
      }
    })
  }

  _formatUptime(seconds) {
    if (!seconds) return '--'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    if (h > 0) return `${h}h ${m}m ${s}s`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  destroy() {}
}
