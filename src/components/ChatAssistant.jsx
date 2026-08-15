import { useState } from 'preact/hooks';
import { NODE_BY_ID } from '../data/campus.js';
import { formatDuration } from '../lib/pathfinding.js';
import { VoiceAssistant } from './VoiceAssistant.jsx';

const SUGGESTIONS = ['带我去图书馆', '学校简介', '今天要带伞吗'];

export function ChatAssistant({
  messages,
  onSend,
  onVoiceUserTranscript,
  onVoiceAssistantTranscript,
  onVoiceNavigationCommand,
  route,
}) {
  const [input, setInput] = useState('');

  const submit = (event) => {
    event?.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <section class="assistant" aria-labelledby="assistant-title">
      <div class="assistant-heading">
        <div class="assistant-icon" aria-hidden="true">路</div>
        <div>
          <p class="eyebrow">LOCAL CACHE + REALTIME VOICE</p>
          <h2 id="assistant-title">AI 导航助手</h2>
        </div>
        <span class="offline-badge">混合模式</span>
      </div>

      <div class="conversation" aria-live="polite">
        {messages.map((message, index) => (
          <div class={`message ${message.role}`} key={`${message.role}-${index}-${message.text}`}>
            <span>{message.role === 'assistant' ? 'NAV' : 'YOU'}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>

      <div class="suggestions" aria-label="示例问题">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} onClick={() => onSend(suggestion)}>{suggestion}</button>
        ))}
      </div>

      <form class="chat-form" onSubmit={submit}>
        <label class="sr-only" for="navigation-query">输入导航问题</label>
        <input
          id="navigation-query"
          value={input}
          onInput={(event) => setInput(event.currentTarget.value)}
          placeholder="例如：从主入口怎么去图书馆？"
          autocomplete="off"
        />
        <button type="submit" aria-label="发送导航问题">↗</button>
      </form>

      <VoiceAssistant
        route={route}
        onUserTranscript={onVoiceUserTranscript}
        onAssistantTranscript={onVoiceAssistantTranscript}
        onNavigationCommand={onVoiceNavigationCommand}
      />

      {route && (
        <div class="assistant-route" aria-label="助手解析结果">
          <span>{NODE_BY_ID[route.request.from].name}</span>
          <b>→</b>
          <span>{NODE_BY_ID[route.request.to].name}</span>
          <small>{route.summary.distanceMeters} m · {formatDuration(route.summary.durationSeconds)}</small>
        </div>
      )}
    </section>
  );
}
