import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  type ConflictRegionAction,
  ConflictResolutionView,
  normalizeLoreConflictContent,
  normalizeLoreConflictMarkerBoundaries,
  prepareConflictResolution,
  resolvePreparedConflict
} from './ConflictResolutionView'

describe('ConflictResolutionView', () => {
  it('does not pass an unfinished marker stack to the Diffs parser', () => {
    const unfinishedConflict = ['<<<<<<< current', 'local value', '=======', 'incoming value'].join('\n')

    // 工作区可能在 Lore 扫描后又被外部编辑，UI 边界必须把不完整标记降级为只读错误，
    // 不能让第三方解析器在 React 渲染期抛出未捕获异常并击穿整个 Diff 面板。
    expect(() =>
      renderToStaticMarkup(
        <ConflictResolutionView
          content={unfinishedConflict}
          fileName="conflict.txt"
          themeType="dark"
          onResolved={vi.fn()}
        />
      )
    ).not.toThrow()
  })

  it('converts parser failures into an invalid preparation result', async () => {
    const file = {
      name: 'conflict.txt',
      contents: ['<<<<<<< current', 'local value', '=======', 'incoming value'].join('\n')
    }

    await expect(prepareConflictResolution(file, { themeType: 'dark' })).resolves.toEqual({ status: 'invalid' })
  })

  it('accepts complete two-way and diff3 conflict markers', async () => {
    const twoWay = {
      name: 'two-way.txt',
      contents: ['<<<<<<< current', 'local value', '=======', 'incoming value', '>>>>>>> incoming'].join('\n')
    }
    const diff3 = {
      name: 'diff3.txt',
      contents: [
        '<<<<<<< current',
        'local value',
        '||||||| base',
        'base value',
        '=======',
        'incoming value',
        '>>>>>>> incoming'
      ].join('\n')
    }

    await expect(prepareConflictResolution(twoWay, { themeType: 'dark' })).resolves.toMatchObject({
      status: 'ready'
    })
    await expect(prepareConflictResolution(diff3, { themeType: 'dark' })).resolves.toMatchObject({
      status: 'ready'
    })
  })

  it('repairs Lore markers appended to content without a trailing newline', async () => {
    const rawContents = [
      '<<<<<<< ours',
      'local value||||||| original',
      'base value=======',
      'incoming value>>>>>>> theirs'
    ].join('\n')
    const normalizedContents = [
      '<<<<<<< ours',
      'local value',
      '||||||| original',
      'base value',
      '=======',
      'incoming value',
      '>>>>>>> theirs'
    ].join('\n')

    expect(normalizeLoreConflictMarkerBoundaries(rawContents)).toBe(normalizedContents)
    await expect(
      prepareConflictResolution({ name: 'lore-conflict.txt', contents: rawContents }, { themeType: 'dark' })
    ).resolves.toMatchObject({
      status: 'ready',
      value: { file: { contents: normalizedContents } }
    })
  })

  it('never replaces the whole file with empty content when accepting a non-empty current change', () => {
    const sourceContents = [
      'before',
      '<<<<<<< ours',
      'current value',
      '=======',
      'incoming value',
      '>>>>>>> theirs',
      'after'
    ].join('\n')
    const action: ConflictRegionAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 1,
      endMarkerContentIndex: 1,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 1,
        startLineNumber: 2,
        separatorLineIndex: 3,
        separatorLineNumber: 4,
        endLineIndex: 5,
        endLineNumber: 6
      },
      markerLines: {
        start: '<<<<<<< ours\n',
        separator: '=======\n',
        end: '>>>>>>> theirs\n'
      }
    }

    const resolved = resolvePreparedConflict({ name: 'conflict.txt', contents: sourceContents }, action, 'current')

    expect(sourceContents.length).toBeGreaterThan(0)
    expect(resolved?.contents).toBe(['before', 'current value', 'after'].join('\n'))
  })

  it('resolves incoming and both sides of a diff3 region without changing surrounding content', () => {
    const sourceContents = [
      'before',
      '<<<<<<< ours',
      'current value',
      '||||||| original',
      'base value',
      '=======',
      'incoming value',
      '>>>>>>> theirs',
      'after'
    ].join('\n')
    const action: ConflictRegionAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 2,
      endMarkerContentIndex: 2,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 1,
        startLineNumber: 2,
        baseMarkerLineIndex: 3,
        baseMarkerLineNumber: 4,
        separatorLineIndex: 5,
        separatorLineNumber: 6,
        endLineIndex: 7,
        endLineNumber: 8
      },
      markerLines: {
        start: '<<<<<<< ours\n',
        base: '||||||| original\n',
        separator: '=======\n',
        end: '>>>>>>> theirs\n'
      }
    }
    const file = { name: 'conflict.txt', contents: sourceContents }

    expect(resolvePreparedConflict(file, action, 'incoming')?.contents).toBe(
      ['before', 'incoming value', 'after'].join('\n')
    )
    expect(resolvePreparedConflict(file, action, 'both')?.contents).toBe(
      ['before', 'current value', 'incoming value', 'after'].join('\n')
    )
  })

  it('keeps later conflict regions unresolved after accepting only one region', () => {
    const sourceContents = [
      '<<<<<<< ours',
      'first current',
      '=======',
      'first incoming',
      '>>>>>>> theirs',
      'middle',
      '<<<<<<< ours',
      'second current',
      '=======',
      'second incoming',
      '>>>>>>> theirs'
    ].join('\n')
    const firstAction: ConflictRegionAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 1,
      endMarkerContentIndex: 1,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 0,
        startLineNumber: 1,
        separatorLineIndex: 2,
        separatorLineNumber: 3,
        endLineIndex: 4,
        endLineNumber: 5
      },
      markerLines: {
        start: '<<<<<<< ours\n',
        separator: '=======\n',
        end: '>>>>>>> theirs\n'
      }
    }

    const resolved = resolvePreparedConflict({ name: 'conflict.txt', contents: sourceContents }, firstAction, 'current')

    expect(resolved?.contents).toBe(
      [
        'first current',
        'middle',
        '<<<<<<< ours',
        'second current',
        '=======',
        'second incoming',
        '>>>>>>> theirs'
      ].join('\n')
    )
  })

  it('refuses to resolve when action markers no longer match the file snapshot', () => {
    const file = {
      name: 'conflict.txt',
      contents: ['<<<<<<< ours', 'current', '=======', 'incoming', '>>>>>>> theirs'].join('\n')
    }
    const staleAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 1,
      endMarkerContentIndex: 1,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 0,
        startLineNumber: 1,
        separatorLineIndex: 2,
        separatorLineNumber: 3,
        endLineIndex: 4,
        endLineNumber: 5
      },
      markerLines: {
        start: '<<<<<<< stale\n',
        separator: '=======\n',
        end: '>>>>>>> theirs'
      }
    } satisfies ConflictRegionAction

    expect(resolvePreparedConflict(file, staleAction, 'current')).toBeUndefined()
  })

  it('does not retain synthetic newlines inserted before Lore conflict markers', () => {
    const rawContents = [
      '<<<<<<< ours',
      'current value||||||| original',
      'base value=======',
      'incoming value>>>>>>> theirs'
    ].join('\n')
    const normalized = normalizeLoreConflictContent(rawContents)
    const action: ConflictRegionAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 2,
      endMarkerContentIndex: 2,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 0,
        startLineNumber: 1,
        baseMarkerLineIndex: 2,
        baseMarkerLineNumber: 3,
        separatorLineIndex: 4,
        separatorLineNumber: 5,
        endLineIndex: 6,
        endLineNumber: 7
      },
      markerLines: {
        start: '<<<<<<< ours\n',
        base: '||||||| original\n',
        separator: '=======\n',
        end: '>>>>>>> theirs'
      }
    }
    const file = { name: 'conflict.txt', contents: normalized.contents }

    expect(resolvePreparedConflict(file, action, 'current', normalized.syntheticMarkerLineIndices)?.contents).toBe(
      'current value'
    )
    expect(resolvePreparedConflict(file, action, 'incoming', normalized.syntheticMarkerLineIndices)?.contents).toBe(
      'incoming value'
    )
    expect(resolvePreparedConflict(file, action, 'both', normalized.syntheticMarkerLineIndices)?.contents).toBe(
      'current valueincoming value'
    )
  })

  it('preserves real CRLF line endings while resolving a standard conflict', () => {
    const contents = [
      'before',
      '<<<<<<< ours',
      'current value',
      '=======',
      'incoming value',
      '>>>>>>> theirs',
      'after'
    ].join('\r\n')
    const action: ConflictRegionAction = {
      conflictIndex: 0,
      hunkIndex: 0,
      startContentIndex: 0,
      endContentIndex: 1,
      endMarkerContentIndex: 1,
      conflict: {
        conflictIndex: 0,
        startLineIndex: 1,
        startLineNumber: 2,
        separatorLineIndex: 3,
        separatorLineNumber: 4,
        endLineIndex: 5,
        endLineNumber: 6
      },
      markerLines: {
        start: '<<<<<<< ours\r\n',
        separator: '=======\r\n',
        end: '>>>>>>> theirs\r\n'
      }
    }

    expect(resolvePreparedConflict({ name: 'conflict.txt', contents }, action, 'current')?.contents).toBe(
      ['before', 'current value', 'after'].join('\r\n')
    )
  })
})
