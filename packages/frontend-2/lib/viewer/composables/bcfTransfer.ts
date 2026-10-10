import { useAuthCookie } from '~~/lib/auth/composables/auth'
import { ToastNotificationType, useGlobalToast } from '~~/lib/common/composables/toast'
import { useInjectedViewerState } from '~~/lib/viewer/composables/setup'

export type BcfExportVersion = '2.1' | '3.0'

type BcfImportReport = {
  version: string
  topicsCreated: number
  topicsUpdated: number
  topicsUnchanged: number
  topicsFailed: number
  commentsCreated: number
  viewpointsCreated: number
  topics: Array<{ title: string; status: string; error?: string }>
  warnings: string[]
}

const fileNameFrom = (disposition: string | null, fallback: string) => {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) return decodeURIComponent(encoded)
  return disposition?.match(/filename="?([^";]+)"?/i)?.[1] || fallback
}

const errorMessage = async (res: Response) => {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error || res.statusText
  } catch {
    return res.statusText
  }
}

/**
 * Import/export of BCF archives (.bcf / .bcfzip) for the topics of the
 * models loaded in the viewer -- see the server's modules/comments/rest/bcf.ts.
 */
export function useViewerBcfTransfer() {
  const apiOrigin = useApiOrigin()
  const authToken = useAuthCookie()
  const { triggerNotification } = useGlobalToast()
  const {
    projectId,
    resources: {
      request: { resourceIdString, threadFilters }
    }
  } = useInjectedViewerState()

  const busy = ref(false)
  const headers = (): Record<string, string> =>
    authToken.value ? { Authorization: `Bearer ${authToken.value}` } : {}

  const exportBcf = async (version: BcfExportVersion) => {
    if (busy.value) return
    busy.value = true
    try {
      const query = new URLSearchParams({
        version,
        resourceIdString: resourceIdString.value
      })
      if (threadFilters.value.loadedVersionsOnly) query.set('loadedVersionsOnly', 'true')
      const res = await fetch(
        `${apiOrigin}/api/projects/${projectId.value}/bcf/export?${query.toString()}`,
        { headers: headers() }
      )
      if (!res.ok) throw new Error(await errorMessage(res))

      const count = Number(res.headers.get('X-Bcf-Topic-Count') || 0)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = fileNameFrom(
        res.headers.get('Content-Disposition'),
        `topics.${version === '3.0' ? 'bcf' : 'bcfzip'}`
      )
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)

      triggerNotification({
        type: ToastNotificationType.Success,
        title: `BCF ${version} exported`,
        description: `${count} topic${count === 1 ? '' : 's'} in ${link.download}`
      })
    } catch (e) {
      triggerNotification({
        type: ToastNotificationType.Danger,
        title: 'BCF export failed',
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      busy.value = false
    }
  }

  const importBcf = async (file: File) => {
    if (busy.value) return
    busy.value = true
    try {
      const body = new FormData()
      body.append('file', file, file.name)
      const query = new URLSearchParams({ resourceIdString: resourceIdString.value })
      const res = await fetch(
        `${apiOrigin}/api/projects/${projectId.value}/bcf/import?${query.toString()}`,
        { method: 'POST', headers: headers(), body }
      )
      if (!res.ok) throw new Error(await errorMessage(res))
      const report = (await res.json()) as BcfImportReport

      const parts = [
        report.topicsCreated && `${report.topicsCreated} created`,
        report.topicsUpdated && `${report.topicsUpdated} updated`,
        report.topicsUnchanged && `${report.topicsUnchanged} unchanged`,
        report.topicsFailed && `${report.topicsFailed} failed`
      ].filter(Boolean)
      const failed = report.topics.filter((t) => t.status === 'failed')
      triggerNotification({
        type: report.topicsFailed ? ToastNotificationType.Warning : ToastNotificationType.Success,
        title: `BCF ${report.version} imported: ${parts.join(', ') || 'no topics'}`,
        description: [
          `${report.commentsCreated} comments and ${report.viewpointsCreated} viewpoints added.`,
          ...failed.slice(0, 3).map((t) => `"${t.title}": ${t.error}`),
          ...report.warnings.slice(0, 3)
        ].join(' ')
      })
    } catch (e) {
      triggerNotification({
        type: ToastNotificationType.Danger,
        title: 'BCF import failed',
        description: e instanceof Error ? e.message : String(e)
      })
    } finally {
      busy.value = false
    }
  }

  return { busy, exportBcf, importBcf }
}
