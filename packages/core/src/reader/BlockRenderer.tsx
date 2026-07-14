import type { Block, StyleSpan } from '../lib/types';
import type { JSX } from 'preact';

export function BlockRenderer({ block, first }: { block: Block; first: boolean }): JSX.Element | null {
  switch (block.type) {
    case 'paragraph':
      return (
        <p class={`para${first ? ' para-first' : ''}`} data-block-id={block.id}>
          {renderSpans(block.text, block.spans)}
        </p>
      );
    case 'scene-break':
      return (
        <div class="scene-break" data-block-id={block.id} aria-hidden="true">
          — · —
        </div>
      );
    case 'display-beat':
      return (
        <p class="display-beat" data-block-id={block.id}>
          {block.text}
        </p>
      );
    case 'message-block':
      return (
        <div class="message-block" data-block-id={block.id}>
          {block.messages.map((m, i) => (
            <div class="message" key={i}>
              <span class="message-meta">
                {m.speaker} ({m.time}):
              </span>{' '}
              <span class="message-text">{m.text}</span>
            </div>
          ))}
        </div>
      );
    case 'image':
      return (
        <figure class="story-figure" data-block-id={block.id}>
          <img class="story-image" src={block.src} alt={block.alt} loading="lazy" decoding="async" />
          {block.alt ? <figcaption class="story-figcaption">{block.alt}</figcaption> : null}
        </figure>
      );
    case 'end-marker':
      return (
        <p class="end-marker" data-block-id={block.id}>
          {block.text}
        </p>
      );
  }
  return null;
}

function renderSpans(text: string, spans?: StyleSpan[]): (string | JSX.Element)[] {
  if (!spans?.length) return [text];
  const out: (string | JSX.Element)[] = [];
  let cursor = 0;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  sorted.forEach((s, i) => {
    if (s.start > cursor) out.push(text.slice(cursor, s.start));
    const inner = text.slice(s.start, s.end);
    out.push(s.style === 'strong' ? <strong key={i}>{inner}</strong> : <em key={i}>{inner}</em>);
    cursor = s.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
