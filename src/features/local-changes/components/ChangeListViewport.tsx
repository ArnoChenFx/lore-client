import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { ChangeTreeRow } from '../../../shared/lib'
import { changeListOffsets, changeListTabTargets, changeListWindow } from '../lib/changeListWindow'

interface ChangeListViewportProps {
  rows: readonly ChangeTreeRow[]
  selectedIds: ReadonlySet<string>
  renderRow: (row: ChangeTreeRow, index: number) => ReactNode
  empty: ReactNode
}

/** Window only this scrolling partition; selection and directory actions keep the complete model. */
export function ChangeListViewport({ rows, selectedIds, renderRow, empty }: ChangeListViewportProps) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<{ id: string; toggle: boolean } | null>(null)
  const appliedFocusRef = useRef(pendingFocus)
  const virtual = rows.length > 200
  const offsets = useMemo(() => changeListOffsets(rows, heights), [rows, heights])
  const tabTargets = useMemo(() => changeListTabTargets(rows, selectedIds), [rows, selectedIds])
  const indices = useMemo(
    () =>
      virtual
        ? changeListWindow(
            offsets,
            viewport.top,
            viewport.height,
            rows.findIndex((row) => row.id === focusedId),
            [tabTargets[0], tabTargets.at(-1)].map((target) => rows.findIndex((row) => row.id === target?.id))
          )
        : rows.map((_, index) => index),
    [offsets, viewport, rows, focusedId, tabTargets, virtual]
  )

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !virtual) return
    const updateViewport = () => {
      const next = { top: body.scrollTop, height: body.clientHeight }
      setViewport((current) => (current.top === next.top && current.height === next.height ? current : next))
    }
    updateViewport()
    const ids = new Set(rows.map((row) => row.id))
    const observer = new ResizeObserver((entries) => {
      updateViewport()
      setHeights((current) => {
        let next: Map<string, number> | null = null
        for (const id of current.keys()) {
          if (!ids.has(id)) {
            next ??= new Map(current)
            next.delete(id)
          }
        }
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          const id = element.dataset.changeWindowRow
          if (id === undefined) continue
          const size = entry.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height
          if (size <= 0 || current.get(id) === size) continue
          next ??= new Map(current)
          next.set(id, size)
        }
        return next ?? current
      })
    })
    observer.observe(body)
    body.querySelectorAll<HTMLElement>('[data-change-window-row]').forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [indices, rows, virtual])

  useLayoutEffect(() => {
    if (!pendingFocus || appliedFocusRef.current === pendingFocus) return
    const wrapper = bodyRef.current?.querySelector<HTMLElement>(
      `[data-change-window-row="${CSS.escape(pendingFocus.id)}"]`
    )
    const target = wrapper?.querySelector<HTMLElement>(
      pendingFocus.toggle ? '.change-directory-row__toggle' : '[role="option"]'
    )
    target?.focus({ preventScroll: true })
    appliedFocusRef.current = pendingFocus
  }, [pendingFocus, indices])

  return (
    <div
      ref={bodyRef}
      className="change-group__body"
      role="listbox"
      aria-multiselectable="true"
      tabIndex={-1}
      onScroll={(event) => {
        if (!virtual) return
        setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }}
      onFocusCapture={(event) => {
        const wrapper = (event.target as HTMLElement).closest<HTMLElement>('[data-change-window-row]')
        if (wrapper) setFocusedId(wrapper.dataset.changeWindowRow!)
      }}
      onKeyDownCapture={(event) => {
        if (!virtual || event.key !== 'Tab') return
        const element = event.target as HTMLElement
        const wrapper = element.closest<HTMLElement>('[data-change-window-row]')
        if (!wrapper) return
        const current = tabTargets.findIndex(
          (target) =>
            target.id === wrapper.dataset.changeWindowRow &&
            target.toggle === element.classList.contains('change-directory-row__toggle')
        )
        const next = tabTargets[current + (event.shiftKey ? -1 : 1)]
        if (current < 0 || !next) return
        event.preventDefault()
        const index = rows.findIndex((row) => row.id === next.id)
        const body = event.currentTarget
        if (offsets[index] < body.scrollTop) body.scrollTop = offsets[index]
        else if (offsets[index + 1] > body.scrollTop + body.clientHeight) {
          body.scrollTop = offsets[index + 1] - body.clientHeight
        }
        setViewport({ top: body.scrollTop, height: body.clientHeight })
        setFocusedId(next.id)
        setPendingFocus(next)
      }}
    >
      {rows.length === 0 ? (
        empty
      ) : (
        <div
          className={virtual ? 'change-list-window' : undefined}
          style={{ height: virtual ? offsets.at(-1) : undefined }}
        >
          {indices.map((index) => (
            <div
              key={rows[index].id}
              className={virtual ? 'change-list-window__row' : undefined}
              data-change-window-row={rows[index].id}
              style={{ top: virtual ? offsets[index] : undefined }}
              role="presentation"
            >
              {renderRow(rows[index], index)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
