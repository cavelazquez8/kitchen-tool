import { Fragment } from 'react';

function inline(text: string) {
  return text.split(/(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) {
      try {
        const url = new URL(link[2]);
        if (!url.username && !url.password)
          return (
            <a href={url.href} target="_blank" rel="noreferrer" key={index}>
              {link[1]}
            </a>
          );
      } catch {
        /* Keep malformed links as readable text. */
      }
    }
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

/** Render the small formatting vocabulary used in conversation without inserting HTML. */
export function ConversationText({ text }: { text: string }) {
  return (
    <div className="conversation-text">
      {text.split(/\n\s*\n/).map((block, index) => {
        const lines = block.split('\n');
        if (lines.every((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line))) {
          return (
            <ul key={index}>
              {lines.map((line, item) => (
                <li key={item}>{inline(line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{inline(block.replace(/^#{1,3}\s+/gm, ''))}</p>;
      })}
    </div>
  );
}
