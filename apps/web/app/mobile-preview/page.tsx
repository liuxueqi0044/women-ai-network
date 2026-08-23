'use client';

import { useState } from 'react';
import './mobile-preview.css';

const screens = [
  { id: 'messages', label: '聊天', detail: '私聊、圈子群聊和私人信' },
  { id: 'connect', label: '联系', detail: '联系人、发现连接和圈子' },
  { id: 'world', label: '世界', detail: '生活记录和全球公开信' },
  { id: 'me', label: '我的', detail: '资料、身份、安全与隐私' },
] as const;

type ScreenId = (typeof screens)[number]['id'];
type PreviewScenario = 'message-incoming' | 'message-sent' | 'letter-published' | null;

export default function MobilePreviewPage() {
  const [screen, setScreen] = useState<ScreenId>('messages');
  const [scenario, setScenario] = useState<PreviewScenario>('message-incoming');

  const frameSource =
    scenario === 'message-incoming'
      ? '/messages?preview=message-incoming'
      : scenario === 'message-sent'
        ? '/messages?preview=message-sent'
        : scenario === 'letter-published'
          ? '/world?preview=letter-published'
          : `/${screen}`;

  return (
    <main className="mobile-preview-shell">
      <aside className="mobile-preview-controls">
        <div>
          <p>WOMEN AI NETWORK</p>
          <h1>手机端预览</h1>
          <span>固定 390 × 844 画布</span>
        </div>
        <nav aria-label="选择手机页面">
          {screens.map((item, index) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={screen === item.id}
              onClick={() => {
                setScreen(item.id);
                setScenario(null);
              }}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </nav>
        <section className="mobile-preview-scenarios" aria-labelledby="preview-scenarios-title">
          <p id="preview-scenarios-title">消息与发布演示</p>
          <button
            type="button"
            aria-pressed={scenario === 'message-incoming'}
            onClick={() => {
              setScreen('messages');
              setScenario('message-incoming');
            }}
          >
            查看收到新消息
          </button>
          <button
            type="button"
            aria-pressed={scenario === 'message-sent'}
            onClick={() => {
              setScreen('messages');
              setScenario('message-sent');
            }}
          >
            查看已发送交流信息
          </button>
          <button
            type="button"
            aria-pressed={scenario === 'letter-published'}
            onClick={() => {
              setScreen('world');
              setScenario('letter-published');
            }}
          >
            查看已发布公开信
          </button>
        </section>
        <p className="mobile-preview-note">
          这是固定手机画布，不受外层浏览器窗口宽度影响。画布内页面仍使用真实生产代码与 API。
        </p>
      </aside>

      <section className="mobile-preview-device" aria-label={`${screen} 手机端画布`}>
        <iframe
          key={`${screen}-${scenario ?? 'live'}`}
          className="mobile-preview-frame"
          src={frameSource}
          title={`Women AI Network · ${screens.find((item) => item.id === screen)?.label ?? screen}`}
        />
      </section>
    </main>
  );
}
