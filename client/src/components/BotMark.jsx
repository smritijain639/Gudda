import React from 'react';

// The VS Bot logo: a rounded blue tile with a document-check glyph.
export default function BotMark({ size = 40 }) {
  const r = Math.round(size * 0.28);
  return (
    <div
      className="bot-mark"
      style={{
        width: size,
        height: size,
        borderRadius: r,
      }}
      aria-label="VS Bot"
    >
      <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} aria-hidden="true">
        <path
          fill="#fff"
          d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm-3.2 14.6-2.8-2.8 1.4-1.4 1.4 1.4 3.6-3.6 1.4 1.4-5 5Z"
        />
      </svg>
    </div>
  );
}
