import { useState } from 'preact/hooks';

const SUGGESTIONS = ['带我去图书馆', '学校简介', '今天要带伞吗'];

export function ChatAssistant({ messages, onSend }) {
  const [input, setInput] = useState('');

  const submit = (event) => {
    event?.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div class="assistant-dialogue" aria-label="AI 导航对话">
      <div class="assistant-console-heading">
        <span>AI DIALOGUE</span>
        <small>本地快速解析 · 语音见右上角菜单</small>
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
    </div>
  );
}
