import { BaseAction, Schema } from '../BaseAction'
import { ActionName } from '../types'
import { MessageUnique } from '@/common/utils/messageUnique'
import { Dict } from 'cosmokit'

interface Payload {
  emojiId: string
  emojiType: string
  message_id: string | number
  count: string | number
}

export class FetchEmojiLike extends BaseAction<Payload, Dict> {
  actionName = ActionName.FetchEmojiLike
  payloadSchema = Schema.object({
    emojiId: Schema.string().required(),
    emojiType: Schema.string().required(),
    message_id: Schema.union([Number, String]).required(),
    count: Schema.union([Number, String]).default(20)
  })

  async _handle(payload: Payload) {
    const msgInfo = await MessageUnique.getMsgIdAndPeerByShortId(+payload.message_id)
    if (!msgInfo) throw new Error('消息不存在')
    const { msgSeq } = (await this.ctx.ntMsgApi.getMsgsByMsgId(msgInfo.Peer, [msgInfo.MsgId])).msgList[0]
    return await this.ctx.ntMsgApi.getMsgEmojiLikesList(msgInfo.Peer, msgSeq, payload.emojiId, payload.emojiType, +payload.count)
  }
}