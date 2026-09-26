import { useState } from 'react';

interface Props {
  prompt: string;
  onClose: () => void;
}

export default function AssembledPromptModal({ prompt, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-panel border border-line rounded-[20px] w-[600px] max-h-[80vh] flex flex-col shadow-panel z-10">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <span className="text-ink font-semibold">Assembled Prompt</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="text-[11px] px-3 py-1 rounded-md bg-line hover:bg-line/80 text-ink transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button onClick={onClose} className="text-muted hover:text-ink">×</button>
          </div>
        </div>
        <div
          className="flex-1 overflow-y-auto p-5"
          style={{ scrollbarWidth: 'thin', scrollbarColor: '#242C3D transparent' }}
        >
          <pre className="text-ink text-[11px] font-mono whitespace-pre-wrap leading-relaxed">{prompt}</pre>
        </div>
      </div>
    </div>
  );
}
