import type { ReactElement } from 'react'
import { Icon, List } from '@raycast/api'
import { usePromise } from '@raycast/utils'
import { getLanguageName } from '../data/languages'
import type { TranslateResult } from '../types'
import { translate } from '../logic/translator'
import { translateOptions } from '../logic/hooks'

export function TranslateDetail({ item }: { item: TranslateResult }): ReactElement {
  const canTranslateBack = item.from !== 'auto'
  const { data: translatedBack, isLoading } = usePromise(
    translate,
    [item.translated, item.to, item.from, translateOptions],
    { execute: canTranslateBack },
  )

  const backText = translatedBack?.translated || ''
  let markdown = item.translated
  if (backText && backText !== item.original)
    markdown += `\n\n------\n\n${backText}`

  const isTheSame = Boolean(backText) && backText.trim().toLowerCase() === item.original.trim().toLowerCase()
  const backStatusText = !canTranslateBack
    ? 'Unavailable'
    : isLoading
      ? 'Loading...'
      : !backText
          ? 'Unavailable'
          : isTheSame
            ? 'Same'
            : 'Different'
  const backStatusIcon = !canTranslateBack
    ? Icon.Minus
    : isLoading
      ? Icon.CircleProgress
      : !backText
          ? Icon.Minus
          : isTheSame
            ? Icon.Checkmark
            : Icon.Info

  return (
    <List.Item.Detail
      markdown={markdown}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="From" text={`${getLanguageName(item.from)} [${item.from}]`} />
          <List.Item.Detail.Metadata.Label title="To" text={`${getLanguageName(item.to)} [${item.to}]`} />
          <List.Item.Detail.Metadata.Separator />
          <List.Item.Detail.Metadata.Label
            title="Translate Back"
            text={backStatusText}
            icon={backStatusIcon}
          />
        </List.Item.Detail.Metadata>
      }
    />
  )
}
