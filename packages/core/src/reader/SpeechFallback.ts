import type { ChapterContent, Block } from '../lib/types';

/**
 * Web Speech API fallback for chapters without pre-generated audio.
 * Chrome kills long utterances, so we speak sentence-by-sentence; iOS fires
 * boundary events unreliably, so there we highlight at block level only.
 */
export class SpeechFallback {
  private content: ChapterContent | null = null;
  private container: HTMLElement | null = null;
  private blockIndex = 0;
  private speaking = false;
  private onDone: (() => void) | null = null;
  private onBlockChange: ((blockId: string) => void) | null = null;

  get supported(): boolean {
    return 'speechSynthesis' in window;
  }

  start(
    content: ChapterContent,
    container: HTMLElement | null,
    fromBlockId: string | null,
    onBlockChange: (blockId: string) => void,
    onDone: () => void
  ): void {
    this.stop();
    this.content = content;
    this.container = container;
    this.onDone = onDone;
    this.onBlockChange = onBlockChange;
    this.blockIndex = fromBlockId ? Math.max(0, content.blocks.findIndex((b) => b.id === fromBlockId)) : 0;
    this.speaking = true;
    this.speakBlock();
  }

  stop(): void {
    this.speaking = false;
    speechSynthesis.cancel();
    this.container?.querySelector('.block-active')?.classList.remove('block-active');
  }

  get active(): boolean {
    return this.speaking;
  }

  private speakBlock(): void {
    if (!this.speaking || !this.content) return;
    const blocks = this.content.blocks;
    while (this.blockIndex < blocks.length && !speakableText(blocks[this.blockIndex])) this.blockIndex++;
    if (this.blockIndex >= blocks.length) {
      this.speaking = false;
      this.onDone?.();
      return;
    }
    const block = blocks[this.blockIndex];
    this.highlightBlock(block.id);
    this.onBlockChange?.(block.id);

    const sentences = splitSentences(speakableText(block));
    let s = 0;
    const speakNext = (): void => {
      if (!this.speaking) return;
      if (s >= sentences.length) {
        this.blockIndex++;
        this.speakBlock();
        return;
      }
      const utterance = new SpeechSynthesisUtterance(sentences[s++]);
      utterance.onend = speakNext;
      utterance.onerror = speakNext;
      speechSynthesis.speak(utterance);
    };
    speakNext();
  }

  private highlightBlock(blockId: string): void {
    if (!this.container) return;
    this.container.querySelector('.block-active')?.classList.remove('block-active');
    const el = this.container.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`);
    el?.classList.add('block-active');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function speakableText(block: Block): string {
  switch (block.type) {
    case 'paragraph':
    case 'display-beat':
    case 'end-marker':
      return block.text;
    case 'message-block':
      return block.messages.map((m) => `${m.speaker}: ${m.text}`).join(' ');
    case 'scene-break':
    case 'image':
      return '';
  }
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g);
  return parts?.map((p) => p.trim()).filter(Boolean) ?? [text];
}

export const speechFallback = new SpeechFallback();
