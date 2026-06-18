// MCP tool dots along the bottom; a lit tool shows a countdown window.
import React from 'react'
import type { ToolNode } from '../../types/constellation.js'
import { Window } from './Window.js'

export function toolPos(i: number, count: number, w: number, h: number, botSafe: number): { x: number; y: number } {
  return { x: w / 2 + (i - (count - 1) / 2) * 50, y: h - botSafe + 20 }
}

function countdown(activeUntil: number, now: number): string {
  const secsLeft = Math.max(0, Math.ceil((activeUntil - now) / 1000))
  return `${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s`
}

export function ToolStrip({ tools, w, h, botSafe, now }: {
  tools: Array<ToolNode>; w: number; h: number; botSafe: number; now: number
}): React.ReactElement {
  return (
    <>
      {tools.map((tool, i) => {
        const { x, y } = toolPos(i, tools.length, w, h, botSafe)
        const lit = !!tool.activeUntil && tool.activeUntil > now
        return (
          <React.Fragment key={tool.id}>
            <div className={`tdot${lit ? ' lit' : ''}`} style={{ left: x, top: y }} title={tool.name}>
              <span className="c">{tool.name.replace(/-/g, '').slice(0, 3).toUpperCase()}</span>
              <span className="t">{tool.name.split('-')[0]}</span>
            </div>
            {lit && (
              <Window
                id={tool.id} x={x} y={y - 120} width={200} focus extraClass="above"
                tabContent={<>
                  <span className="win-name" style={{ fontWeight: 700 }}>{tool.name}</span>
                  <span className="win-verb">{countdown(tool.activeUntil!, now)}</span>
                </>}
              >
                {tool.description && (
                  <div className="win-body">
                    <div className="gl g-axle">{tool.description}</div>
                  </div>
                )}
              </Window>
            )}
          </React.Fragment>
        )
      })}
    </>
  )
}
