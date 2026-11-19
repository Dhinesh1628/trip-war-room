import { useEffect, useRef, useState } from 'react';
import { IconThumbUp, IconThumbDown, IconHeart, IconMoodHappy, IconMoodSurprised, IconConfetti, IconSparkles } from '@tabler/icons-react';
import { useI18n } from '../../lib/i18n.jsx';

// The server stores six fixed reactions; they are shown as quiet icons.
const REACTIONS = [
  ['👍', IconThumbUp, 'Agree'],
  ['❤️', IconHeart, 'Love it'],
  ['😂', IconMoodHappy, 'Funny'],
  ['😮', IconMoodSurprised, 'Wow'],
  ['🎉', IconConfetti, 'Celebrate'],
  ['👎', IconThumbDown, 'Disagree'],
];

export default function ChatPanel({ room, active }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [picker, setPicker] = useState(null);
  const log = useRef(null);
  const typingSent = useRef(false);
  const me = room.me.userId;

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [room.chat.length]);

  function typing(isTyping) {
    if (typingSent.current === isTyping) return;
    typingSent.current = isTyping;
    room.send('trip.chat.typing', { isTyping });
  }

  async function send(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    const r = await room.send('trip.chat.send', { body, clientMsgId: `${me}-${Date.now()}` });
    if (r.ok) {
      setText('');
      typing(false);
    } else setError(r.error.message);
  }

  const typists = Object.entries(room.typing).filter(([id]) => id !== me).map(([, x]) => x.name);

  return (
    <section className={`panel ${active ? 'active-tab' : ''}`} data-tab="chat" aria-label={t('Chat')}>
      <p className="panel-title">{t('Chat')}</p>
      <div className="chat-log" ref={log} aria-live="polite">
        {room.chat.map((m) => {
          if (m.type === 'system') return <div key={m.messageId} className="msg-system" lang="en">{m.body}</div>;
          if (m.type === 'conflict') return <div key={m.messageId} className="msg-conflict" lang="en">{m.body}</div>;
          const ai = m.type === 'ai_answer';
          return (
            <div key={m.messageId} className="small">
              <span style={{ fontWeight: 500 }}>
                {ai ? <span className="row" style={{ display: 'inline-flex', gap: 3 }}><IconSparkles size={12} aria-hidden="true" />{t('Concierge')}</span> : m.displayName}
              </span>{' '}
              {ai && m.meta?.question && <span className="faint" lang="en">{t('to')} "{m.meta.question}": </span>}
              <span className={ai ? 'voice' : ''} style={ai ? { fontSize: 13 } : undefined} lang={ai ? 'en' : undefined}>{m.body}</span>
              <div className="row wrap" style={{ gap: 4, marginTop: 3 }}>
                {REACTIONS.filter(([e]) => m.reactions?.[e]?.length).map(([e, Icon, label]) => (
                  <button
                    key={e}
                    className={`tag ${m.reactions[e].includes(me) ? 'mine' : ''}`}
                    aria-label={`${t(label)}, ${m.reactions[e].length}`}
                    aria-pressed={m.reactions[e].includes(me)}
                    onClick={() => room.send('trip.chat.react', { messageId: m.messageId, emoji: e })}
                  >
                    <Icon size={12} aria-hidden="true" /> {m.reactions[e].length}
                  </button>
                ))}
                <button className="tag" aria-label={t('Add a reaction')} aria-expanded={picker === m.messageId} onClick={() => setPicker(picker === m.messageId ? null : m.messageId)}>+</button>
                {picker === m.messageId &&
                  REACTIONS.map(([e, Icon, label]) => (
                    <button key={e} className="tag" aria-label={t(label)} title={t(label)} onClick={() => { room.send('trip.chat.react', { messageId: m.messageId, emoji: e }); setPicker(null); }}>
                      <Icon size={13} aria-hidden="true" />
                    </button>
                  ))}
              </div>
            </div>
          );
        })}
        {room.chat.length === 0 && <p className="small muted">{t('No messages yet. Say hello to the group.')}</p>}
      </div>
      <div className="tiny faint" style={{ minHeight: 16 }}>
        {typists.length > 0 && (typists.length > 1 ? t('{names} are typing…', { names: typists.join(', ') }) : t('{name} is typing…', { name: typists[0] }))}
      </div>
      <form onSubmit={send} className="row" noValidate>
        <input
          aria-label={t('Message')}
          placeholder={room.me.muted ? t('You are muted') : t('Message the group')}
          value={text}
          disabled={room.me.muted}
          maxLength={1000}
          onChange={(e) => { setText(e.target.value); setError(null); typing(e.target.value.length > 0); }}
          onBlur={() => typing(false)}
        />
        <button disabled={room.me.muted || !text.trim()}>{t('Send')}</button>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  );
}
