import { useState } from 'preact/hooks';
import { useI18n } from '../lib/i18n.js';

export function ChatAssistant({ messages, onSend }) {
  const { t } = useI18n();
  const [input, setInput] = useState('');

  const submit = (event) => {
    event?.preventDefault();
    if (!input.trim()) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div class="assistant-dialogue" aria-label={t('chat.aria')}>
      <div class="assistant-console-heading">
        <span>AI DIALOGUE</span>
        <small>{t('chat.note')}</small>
      </div>

      <div class="conversation" aria-live="polite">
        {messages.map((message, index) => (
          <div class={`message ${message.role}`} key={`${message.role}-${index}-${message.text}`}>
            <span>{message.role === 'assistant' ? 'NAV' : 'YOU'}</span>
            <p>{message.text}</p>
          </div>
        ))}
      </div>

      <div class="suggestions" aria-label={t('chat.aria')}>
        {t('chat.suggestions').map((suggestion) => (
          <button key={suggestion} onClick={() => onSend(suggestion)}>{suggestion}</button>
        ))}
      </div>

      <form class="chat-form" onSubmit={submit}>
        <label class="sr-only" for="navigation-query">{t('chat.inputLabel')}</label>
        <input
          id="navigation-query"
          value={input}
          onInput={(event) => setInput(event.currentTarget.value)}
          placeholder={t('chat.placeholder')}
          autocomplete="off"
        />
        <button type="submit" aria-label={t('chat.send')}>↗</button>
      </form>
    </div>
  );
}
