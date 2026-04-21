import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquare, Reply as ReplyIcon, Send, Trash2 } from 'lucide-react'
import { supabase, isSupabaseConfigured } from '@/lib/supabase'
import { useAuth } from '@/providers/AuthProvider'
import { useLangContext } from '@/providers/LangProvider'
import AuthModal from './AuthModal'

type EntityType = 'anime' | 'character'

type AuthorProfile = {
  display_name: string | null
  avatar_url: string | null
  username: string | null
}

type CommentRecord = {
  id: string
  user_id: string
  entity_type: EntityType
  entity_id: number
  parent_id: string | null
  body: string
  is_deleted: boolean
  created_at: string
}

type CommentRow = CommentRecord & {
  author?: AuthorProfile | null
}

type Props = {
  entityType: EntityType
  entityId: number
}

export default function CommentSection({ entityType, entityId }: Props) {
  const { user, profile } = useAuth()
  const { t } = useLangContext()
  const [rows, setRows] = useState<CommentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  const formatWhen = (iso: string) => {
    const d = new Date(iso)
    const diff = (Date.now() - d.getTime()) / 1000
    if (diff < 60) return t.justNow
    if (diff < 3600) return t.minutesAgo(Math.floor(diff / 60))
    if (diff < 86400) return t.hoursAgo(Math.floor(diff / 3600))
    if (diff < 7 * 86400) return t.daysAgo(Math.floor(diff / 86400))
    return d.toLocaleDateString()
  }

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) {
      setLoading(false)
      return
    }

    setLoading(true)

    const { data, error } = await supabase
      .from('comments')
      .select('id, user_id, entity_type, entity_id, parent_id, body, is_deleted, created_at')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: true })
      .limit(500)

    if (error || !data) {
      if (error) console.warn('[comments] load failed', error.message)
      setRows([])
      setLoading(false)
      return
    }

    const comments = data as CommentRecord[]
    const userIds = Array.from(new Set(comments.map((item) => item.user_id).filter(Boolean)))

    let authorMap = new Map<string, AuthorProfile>()
    if (userIds.length > 0) {
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, display_name, avatar_url, username')
        .in('id', userIds)

      if (profilesError) {
        console.warn('[comments] profile lookup failed', profilesError.message)
      } else {
        authorMap = new Map(
          (profiles ?? []).map((item) => [
            item.id as string,
            {
              display_name: item.display_name as string | null,
              avatar_url: item.avatar_url as string | null,
              username: item.username as string | null,
            },
          ]),
        )
      }
    }

    setRows(
      comments.map((item) => ({
        ...item,
        author: authorMap.get(item.user_id) ?? null,
      })),
    )
    setLoading(false)
  }, [entityId, entityType])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!isSupabaseConfigured) return

    const channel = supabase
      .channel(`comments-${entityType}-${entityId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'comments',
          filter: `entity_id=eq.${entityId}`,
        },
        () => {
          void load()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [entityId, entityType, load])

  const tree = useMemo(() => {
    const byParent = new Map<string | null, CommentRow[]>()
    rows.forEach((row) => {
      const key = row.parent_id
      const list = byParent.get(key) ?? []
      list.push(row)
      byParent.set(key, list)
    })
    return byParent
  }, [rows])

  const submit = async (text: string, parent: string | null = null) => {
    if (!user) {
      setAuthOpen(true)
      return
    }

    const trimmed = text.trim()
    if (!trimmed) return

    setSubmitting(true)
    const { error } = await supabase.from('comments').insert({
      user_id: user.id,
      entity_type: entityType,
      entity_id: entityId,
      parent_id: parent,
      body: trimmed.slice(0, 2000),
    })
    setSubmitting(false)

    if (!error) {
      if (parent) {
        setReplyTo(null)
        setReplyBody('')
      } else {
        setBody('')
      }
      void load()
    }
  }

  const remove = async (id: string) => {
    if (!user) return
    await supabase.from('comments').delete().eq('id', id).eq('user_id', user.id)
    void load()
  }

  const renderNode = (node: CommentRow, depth = 0) => {
    const children = tree.get(node.id) ?? []
    const authorName = node.author?.display_name || node.author?.username || t.anonymous
    const avatar = node.author?.avatar_url

    return (
      <div
        key={node.id}
        className={`flex gap-3 ${depth > 0 ? 'ml-6 mt-3 border-l border-gray-800 pl-4' : 'mt-4'}`}
      >
        {avatar ? (
          <img src={avatar} alt="" className="h-8 w-8 flex-shrink-0 rounded-full object-cover" />
        ) : (
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
            {authorName[0]?.toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className="font-semibold text-gray-200">{authorName}</span>
            <span>·</span>
            <span>{formatWhen(node.created_at)}</span>
          </div>
          <p className="mt-1 whitespace-pre-line text-sm text-gray-200">{node.body}</p>
          <div className="mt-2 flex items-center gap-3 text-xs">
            {user && (
              <button
                onClick={() => {
                  setReplyTo(node.id === replyTo ? null : node.id)
                  setReplyBody('')
                }}
                className="flex items-center gap-1 text-gray-400 hover:text-primary"
              >
                <ReplyIcon className="h-3.5 w-3.5" />
                {t.reply}
              </button>
            )}
            {user && user.id === node.user_id && (
              <button
                onClick={() => remove(node.id)}
                className="flex items-center gap-1 text-gray-400 hover:text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" /> {t.delete}
              </button>
            )}
          </div>
          {replyTo === node.id && (
            <div className="mt-2 flex gap-2">
              <textarea
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder={t.replyPlaceholder}
                rows={2}
                className="flex-1 rounded-lg border border-gray-700 bg-background px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => void submit(replyBody, node.id)}
                disabled={submitting || !replyBody.trim()}
                className="self-start rounded-lg bg-primary px-3 py-2 text-sm text-white hover:bg-primary-hover disabled:opacity-50"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
          )}
          {children.map((child) => renderNode(child, depth + 1))}
        </div>
      </div>
    )
  }

  const topLevel = tree.get(null) ?? []

  if (!isSupabaseConfigured) {
    return (
      <section className="mb-10">
        <h2 className="mb-4 flex items-center gap-2 text-2xl font-bold text-white">
          <MessageSquare className="h-6 w-6 text-primary" /> {t.comments}
        </h2>
        <div className="rounded-xl border border-gray-800 bg-card p-6 text-sm text-gray-400">
          {t.commentsDisabled}
        </div>
      </section>
    )
  }

  return (
    <section className="mb-10">
      <h2 className="mb-4 flex items-center gap-2 text-2xl font-bold text-white">
        <MessageSquare className="h-6 w-6 text-primary" /> {t.comments}
        <span className="text-base font-normal text-gray-400">({rows.length})</span>
      </h2>

      <div className="rounded-xl border border-gray-800 bg-card p-4">
        {user ? (
          <div className="flex gap-3">
            {profile?.avatar_url || user.user_metadata?.avatar_url ? (
              <img
                src={profile?.avatar_url || user.user_metadata?.avatar_url}
                alt=""
                className="h-9 w-9 flex-shrink-0 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">
                {(profile?.display_name || user.email || 'U')[0].toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t.commentPlaceholder}
                rows={3}
                maxLength={2000}
                className="w-full rounded-lg border border-gray-700 bg-background px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-primary focus:outline-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-gray-500">{body.length}/2000</span>
                <button
                  onClick={() => void submit(body)}
                  disabled={submitting || !body.trim()}
                  className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {t.post}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-background px-4 py-3">
            <span className="text-sm text-gray-400">{t.signInToComment}</span>
            <button
              onClick={() => setAuthOpen(true)}
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-primary-hover"
            >
              {t.signIn}
            </button>
          </div>
        )}

        <div className="mt-2">
          {loading ? (
            <div className="py-6 text-center text-sm text-gray-500">{t.loadingComments}</div>
          ) : topLevel.length === 0 ? (
            <div className="py-6 text-center text-sm text-gray-500">{t.noComments}</div>
          ) : (
            topLevel.map((comment) => renderNode(comment))
          )}
        </div>
      </div>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />
    </section>
  )
}
