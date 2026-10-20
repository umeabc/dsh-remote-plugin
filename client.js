/**
 * Settings → 手机访问.
 *
 * Renders the LAN pairing card (address, QR, six-digit code) and the relay
 * card (address, status, room QR). All data comes from the host routes the
 * plugin registers under /__mobile.
 */

window.__ModuleLoader__.load({
  id: 'dsh-mobile-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const CSS = `
.dshmb-root{display:flex;flex-direction:column;gap:18px;width:100%;color:var(--dsw-alias-label-primary)}
.dshmb-lead{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshmb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:18px}
.dshmb-cardHead{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.dshmb-cardTitle{font-size:14px;font-weight:600;line-height:20px}
.dshmb-pill{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;line-height:16px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.dshmb-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.dshmb-dot[data-on="true"]{background:var(--dsw-alias-state-success-primary)}
.dshmb-dot[data-warn="true"]{background:var(--dsw-alias-state-warn-primary)}
.dshmb-row{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.dshmb-qr{width:180px;height:180px;flex:none;border-radius:12px;background:#fff;padding:8px;box-sizing:border-box}
.dshmb-qr img{width:100%;height:100%;display:block}
.dshmb-detail{display:flex;flex-direction:column;gap:14px;flex:1;min-width:220px}
.dshmb-field{display:flex;flex-direction:column;gap:4px}
.dshmb-label{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dshmb-value{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:20px;word-break:break-all}
.dshmb-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;line-height:34px;letter-spacing:6px;font-weight:600}
.dshmb-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshmb-actions{display:flex;gap:8px;flex-wrap:wrap}
.dshmb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12.5px;line-height:18px;cursor:pointer}
.dshmb-btn:hover{background:var(--dsw-alias-bg-overlay)}
.dshmb-btn:disabled{opacity:.5;cursor:default}
.dshmb-btn[data-kind="primary"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dshmb-input{flex:1;min-width:180px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font-size:13px;line-height:18px;outline:none}
.dshmb-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshmb-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dshmb-relayRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
@media (max-width:560px){.dshmb-qr{width:150px;height:150px}}
`;

    const TEXT = {
      zh: {
        title: '手机访问',
        lead: '在同一个 Wi-Fi 下用手机打开这个页面，或者通过中转服务器从外网访问。电脑上的 DSH 不需要暴露到公网。',
        lan: '同一 Wi-Fi',
        running: '运行中',
        stopped: '未启动',
        address: '地址',
        copy: '复制',
        copied: '已复制',
        code: '配对码',
        refresh: '换一个',
        expires: '剩余',
        devices: '已配对设备',
        revoke: '全部断开',
        none: '暂无',
        relay: '中转服务器',
        relayLead: '填写中转服务器地址后，DSH 会主动建立加密连接。适合电脑在内网、手机在外网的场景。',
        relayPlaceholder: '例如 relay.example.com:9443',
        save: '保存',
        connected: '已连接',
        offline: '未连接',
        relayReset: '更换房间',
        copyLink: '复制连接码',
        scanRelay: '在手机 App 里扫描这个二维码',
        noRelay: '尚未配置中转服务器',
        footnote: '手机首次打开后，可在浏览器里「添加到主屏幕」，像 App 一样使用。配对码 10 分钟内有效。',
        loadFailed: '读取状态失败',
        qrHint: '用手机相机扫描',
      },
      en: {
        title: 'Phone access',
        lead: 'Open this page on a phone on the same Wi-Fi, or reach it from anywhere through a relay. The desktop never has to expose a public port.',
        lan: 'Same Wi-Fi',
        running: 'Running',
        stopped: 'Stopped',
        address: 'Address',
        copy: 'Copy',
        copied: 'Copied',
        code: 'Pairing code',
        refresh: 'New code',
        expires: 'expires in',
        devices: 'Paired devices',
        revoke: 'Disconnect all',
        none: 'none',
        relay: 'Relay server',
        relayLead: 'Point the desktop at a relay server and it keeps one encrypted outbound connection. Use this when the phone is on another network.',
        relayPlaceholder: 'relay.example.com:9443',
        save: 'Save',
        connected: 'Connected',
        offline: 'Offline',
        relayReset: 'New room',
        copyLink: 'Copy link',
        scanRelay: 'Scan this QR in the phone app',
        noRelay: 'No relay configured yet',
        footnote: 'On the phone, use “Add to Home Screen” to keep DSH one tap away. The pairing code expires after 10 minutes.',
        loadFailed: 'Cannot read status',
        qrHint: 'Scan with the phone camera',
      },
    };

    function languageOf(ctx) {
      try {
        return ctx.locale?.getSnapshot?.().active === 'zh' ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    function useLanguage(ctx) {
      const [lang, setLang] = React.useState(() => languageOf(ctx));
      React.useEffect(() => {
        const off = ctx.locale?.subscribe?.(() => setLang(languageOf(ctx)));
        return () => off?.();
      }, []);
      return lang;
    }

    async function call(path, options) {
      const response = await fetch(path, { cache: 'no-store', ...options });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    function formatRemaining(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
    }

    function createSection(ctx) {
      return function MobileSection() {
        const lang = useLanguage(ctx);
        const t = TEXT[lang];
        const [state, setState] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [copied, setCopied] = React.useState(false);
        const [relayDraft, setRelayDraft] = React.useState('');
        const [tick, setTick] = React.useState(0);

        const load = React.useCallback(() => {
          call('/__mobile/status')
            .then((next) => {
              setState(next);
              setError(null);
            })
            .catch((reason) => setError(reason.message));
        }, []);

        React.useEffect(() => {
          load();
          const timer = setInterval(load, 15000);
          const clock = setInterval(() => setTick((value) => value + 1), 1000);
          return () => {
            clearInterval(timer);
            clearInterval(clock);
          };
        }, [load]);

        React.useEffect(() => {
          if (state?.relay?.url && relayDraft === '') setRelayDraft(state.relay.url);
        }, [state?.relay?.url]);

        const act = async (path, body) => {
          setBusy(true);
          try {
            const next = await call(path, {
              method: 'POST',
              headers: body === undefined ? {} : { 'content-type': 'application/json' },
              body: body === undefined ? undefined : JSON.stringify(body),
            });
            setState(next);
            setError(null);
          } catch (reason) {
            setError(reason.message);
          } finally {
            setBusy(false);
          }
        };

        const copy = async (value) => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard unavailable */
          }
        };

        const lan = state?.lan;
        const relay = state?.relay;
        const remaining = lan?.expiresAt ? lan.expiresAt - Date.now() : 0;
        void tick;

        return h('div', { className: 'dshmb-root' },
          h('p', { className: 'dshmb-lead' }, t.lead),

          h('section', { className: 'dshmb-card' },
            h('div', { className: 'dshmb-cardHead' },
              h('span', { className: 'dshmb-cardTitle' }, t.lan),
              h('span', { className: 'dshmb-pill' },
                h('span', { className: 'dshmb-dot', 'data-on': String(Boolean(lan?.running)) }),
                lan?.running ? `${t.running} · ${lan.port}` : t.stopped,
              ),
            ),
            lan?.running
              ? h('div', { className: 'dshmb-row' },
                h('div', { className: 'dshmb-qr' },
                  h('img', { src: '/__mobile/qr.svg?kind=lan', alt: 'LAN QR' }),
                ),
                h('div', { className: 'dshmb-detail' },
                  h('div', { className: 'dshmb-field' },
                    h('span', { className: 'dshmb-label' }, t.address),
                    h('div', { className: 'dshmb-value' },
                      h('span', { className: 'dshmb-mono' }, lan.url ?? '—'),
                      h('button', {
                        className: 'dshmb-btn',
                        onClick: () => copy(lan.url ?? ''),
                      }, copied ? t.copied : t.copy),
                    ),
                  ),
                  h('div', { className: 'dshmb-field' },
                    h('span', { className: 'dshmb-label' }, t.code),
                    h('div', { className: 'dshmb-value' },
                      h('span', { className: 'dshmb-code' }, lan.code ?? '------'),
                      h('span', { className: 'dshmb-note' }, `${t.expires} ${formatRemaining(remaining)}`),
                      h('button', {
                        className: 'dshmb-btn',
                        disabled: busy,
                        onClick: () => act('/__mobile/pair/rotate'),
                      }, t.refresh),
                    ),
                  ),
                  h('div', { className: 'dshmb-field' },
                    h('span', { className: 'dshmb-label' }, t.devices),
                    h('div', { className: 'dshmb-value' },
                      h('span', { className: 'dshmb-mono' }, String(lan.devices ?? 0)),
                      h('button', {
                        className: 'dshmb-btn',
                        disabled: busy || (lan.devices ?? 0) === 0,
                        onClick: () => act('/__mobile/devices/clear'),
                      }, t.revoke),
                    ),
                  ),
                ),
              )
              : h('p', { className: 'dshmb-note' }, t.stopped),
            h('p', { className: 'dshmb-note', style: { marginTop: '12px' } }, t.qrHint),
          ),

          h('section', { className: 'dshmb-card' },
            h('div', { className: 'dshmb-cardHead' },
              h('span', { className: 'dshmb-cardTitle' }, t.relay),
              h('span', { className: 'dshmb-pill' },
                h('span', {
                  className: 'dshmb-dot',
                  'data-on': String(Boolean(relay?.connected)),
                  'data-warn': String(Boolean(relay?.url) && !relay?.connected),
                }),
                relay?.connected ? t.connected : t.offline,
              ),
            ),
            h('p', { className: 'dshmb-note', style: { marginTop: 0 } }, t.relayLead),
            h('div', { className: 'dshmb-relayRow', style: { marginTop: '10px' } },
              h('input', {
                className: 'dshmb-input',
                value: relayDraft,
                placeholder: t.relayPlaceholder,
                spellCheck: false,
                onChange: (event) => setRelayDraft(event.target.value),
              }),
              h('button', {
                className: 'dshmb-btn',
                'data-kind': 'primary',
                disabled: busy,
                onClick: () => act('/__mobile/relay/config', { url: relayDraft.trim() }),
              }, t.save),
            ),
            relay?.pairingText
              ? h('div', { className: 'dshmb-row', style: { marginTop: '16px' } },
                h('div', { className: 'dshmb-qr' },
                  h('img', { src: '/__mobile/qr.svg?kind=relay', alt: 'Relay QR' }),
                ),
                h('div', { className: 'dshmb-detail' },
                  h('div', { className: 'dshmb-field' },
                    h('span', { className: 'dshmb-label' }, 'Room'),
                    h('span', { className: 'dshmb-mono' }, relay.room ?? ''),
                  ),
                  h('div', { className: 'dshmb-field' },
                    h('span', { className: 'dshmb-label' }, 'Key'),
                    h('span', { className: 'dshmb-mono' }, relay.key ?? ''),
                  ),
                  h('div', { className: 'dshmb-actions' },
                    h('button', {
                      className: 'dshmb-btn',
                      onClick: () => copy(relay.pairingText ?? ''),
                    }, copied ? t.copied : t.copyLink),
                    h('button', {
                      className: 'dshmb-btn',
                      disabled: busy,
                      onClick: () => act('/__mobile/relay/reset'),
                    }, t.relayReset),
                  ),
                  h('p', { className: 'dshmb-note', style: { margin: 0 } }, t.scanRelay),
                ),
              )
              : h('p', { className: 'dshmb-note', style: { marginTop: '12px' } }, t.noRelay),
            error !== null ? h('p', { className: 'dshmb-error', style: { marginTop: '10px' } }, `${t.loadFailed}: ${error}`) : null,
          ),

          h('p', { className: 'dshmb-note' }, t.footnote),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = 'dsh-mobile-bridge';
          tag.dataset.pluginCss = 'dsh-mobile-bridge/settings.css';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });

        const Section = createSection(ctx);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mobile-access',
          order: 17,
          label: () => (languageOf(ctx) === 'zh' ? '手机访问' : 'Phone access'),
        }, Section));
      },
    };
  },
});
