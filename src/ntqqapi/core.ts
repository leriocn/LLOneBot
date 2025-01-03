import { unlink } from 'node:fs/promises'
import { Service, Context } from 'cordis'
import { registerCallHook, registerReceiveHook, ReceiveCmdS } from './hook'
import { Config as LLOBConfig } from '../common/types'
import { isNumeric } from '../common/utils/misc'
import { NTMethod } from './ntcall'
import {
  RawMessage,
  GroupNotify,
  FriendRequestNotify,
  FriendRequest,
  GroupMember,
  CategoryFriend,
  SimpleInfo,
  ChatType,
  BuddyReqType,
  GrayTipElementSubType
} from './types'
import { selfInfo } from '../common/globalVars'
import { version } from '../version'
import { invoke } from './ntcall'
import { Native } from './native/crychic'

declare module 'cordis' {
  interface Context {
    app: Core
  }
  interface Events {
    'nt/message-created': (input: RawMessage) => void
    'nt/message-deleted': (input: RawMessage) => void
    'nt/message-sent': (input: RawMessage) => void
    'nt/group-notify': (input: { notify: GroupNotify, doubt: boolean }) => void
    'nt/friend-request': (input: FriendRequest) => void
    'nt/group-member-info-updated': (input: { groupCode: string, members: GroupMember[] }) => void
    'nt/system-message-created': (input: Uint8Array) => void
  }
}

class Core extends Service {
  static inject = ['ntMsgApi', 'ntFriendApi', 'ntGroupApi', 'store']
  public startTime = 0
  public native

  constructor(protected ctx: Context, public config: Core.Config) {
    super(ctx, 'app', true)
    this.native = new Native(ctx)
  }

  public start() {
    this.startTime = Date.now()
    this.registerListener()
    this.ctx.logger.info(`LLOneBot/${version}`)
    this.ctx.on('llob/config-updated', input => {
      Object.assign(this.config, input)
    })
  }

  private registerListener() {
    registerReceiveHook<{
      data?: CategoryFriend[]
      userSimpleInfos?: Map<string, SimpleInfo> //V2
      buddyCategory?: CategoryFriend[] //V2
    }>(ReceiveCmdS.FRIENDS, (payload) => {
      let uids: string[] = []
      if (payload.buddyCategory) {
        uids = payload.buddyCategory.flatMap(item => item.buddyUids)
      } else if (payload.data) {
        uids = payload.data.flatMap(item => item.buddyList.map(e => e.uid))
      }
      for (const uid of uids) {
        this.ctx.ntMsgApi.activateChat({ peerUid: uid, chatType: ChatType.C2C })
      }
      this.ctx.logger.info('好友列表变动', uids.length)
    })

    // 自动清理新消息文件
    registerReceiveHook<{ msgList: RawMessage[] }>([ReceiveCmdS.NEW_MSG, ReceiveCmdS.NEW_ACTIVE_MSG], (payload) => {
      if (!this.config.autoDeleteFile) {
        return
      }
      for (const message of payload.msgList) {
        for (const msgElement of message.elements) {
          setTimeout(() => {
            const picPath = msgElement.picElement?.sourcePath
            const picThumbPath = [...(msgElement.picElement?.thumbPath ?? []).values()]
            const pttPath = msgElement.pttElement?.filePath
            const filePath = msgElement.fileElement?.filePath
            const videoPath = msgElement.videoElement?.filePath
            const videoThumbPath = [...(msgElement.videoElement?.thumbPath ?? []).values()]
            const pathList = [picPath, ...picThumbPath, pttPath, filePath, videoPath, ...videoThumbPath]
            if (msgElement.picElement) {
              pathList.push(...Object.values(msgElement.picElement.thumbPath))
            }
            for (const path of pathList) {
              if (path) {
                unlink(path).then(() => this.ctx.logger.info('删除文件成功', path))
              }
            }
          }, this.config.autoDeleteFileSecond! * 1000)
        }
      }
    })

    registerReceiveHook<{ info: { status: number } }>(ReceiveCmdS.SELF_STATUS, (info) => {
      Object.assign(selfInfo, { online: info.info.status !== 20 })
    })

    const activatedPeerUids: string[] = []
    registerReceiveHook<{
      changedRecentContactLists: {
        listType: number
        sortedContactList: string[]
        changedList: {
          id: string // peerUid
          chatType: ChatType
        }[]
      }[]
    }>(ReceiveCmdS.RECENT_CONTACT, async (payload) => {
      for (const recentContact of payload.changedRecentContactLists) {
        for (const contact of recentContact.changedList) {
          if (activatedPeerUids.includes(contact.id)) continue
          activatedPeerUids.push(contact.id)
          const peer = { peerUid: contact.id, chatType: contact.chatType }
          if (contact.chatType === ChatType.TempC2CFromGroup) {
            this.ctx.ntMsgApi.activateChatAndGetHistory(peer, 2).then(res => {
              for (const msg of res.msgList) {
                if (Date.now() / 1000 - Number(msg.msgTime) > 3) {
                  continue
                }
                if (msg.senderUin && msg.senderUin !== '0') {
                  this.ctx.store.addMsgCache(msg)
                }
                this.ctx.parallel('nt/message-created', msg)
              }
            })
          } else {
            this.ctx.ntMsgApi.activateChat(peer)
          }
        }
      }
    })

    registerCallHook(NTMethod.DELETE_ACTIVE_CHAT, async (payload) => {
      const peerUid = payload[0] as string
      this.ctx.logger.info('激活的聊天窗口被删除，准备重新激活', peerUid)
      let chatType = ChatType.C2C
      if (isNumeric(peerUid)) {
        chatType = ChatType.Group
      }
      else if (!(await this.ctx.ntFriendApi.isBuddy(peerUid))) {
        chatType = ChatType.TempC2CFromGroup
      }
      const peer = { peerUid, chatType }
      await this.ctx.sleep(1000)
      this.ctx.ntMsgApi.activateChat(peer).then((r) => {
        this.ctx.logger.info('重新激活聊天窗口', peer, { result: r.result, errMsg: r.errMsg })
      })
    })

    registerReceiveHook<{
      groupCode: string
      dataSource: number
      members: Set<GroupMember>
    }>(ReceiveCmdS.GROUP_MEMBER_INFO_UPDATE, async (payload) => {
      const groupCode = payload.groupCode
      const members = Array.from(payload.members.values())
      this.ctx.parallel('nt/group-member-info-updated', { groupCode, members })
    })

    registerReceiveHook<{ msgList: RawMessage[] }>([ReceiveCmdS.NEW_MSG, ReceiveCmdS.NEW_ACTIVE_MSG], payload => {
      const startTime = this.startTime / 1000
      for (const message of payload.msgList) {
        // 过滤启动之前的消息
        if (parseInt(message.msgTime) < startTime) {
          continue
        }
        if (message.senderUin && message.senderUin !== '0') {
          this.ctx.store.addMsgCache(message)
        }
        this.ctx.parallel('nt/message-created', message)
      }
    })

    const sentMsgIds = new Map<string, boolean>()
    const recallMsgIds: string[] = [] // 避免重复上报

    registerReceiveHook<{ msgList: RawMessage[] }>([ReceiveCmdS.UPDATE_MSG], payload => {
      for (const msg of payload.msgList) {
        if (
          msg.recallTime !== '0' &&
          msg.msgType === 5 &&
          msg.subMsgType === 4 &&
          msg.elements[0]?.grayTipElement?.subElementType === GrayTipElementSubType.Revoke &&
          !recallMsgIds.includes(msg.msgId)
        ) {
          recallMsgIds.shift()
          recallMsgIds.push(msg.msgId)
          this.ctx.parallel('nt/message-deleted', msg)
        } else if (sentMsgIds.get(msg.msgId)) {
          if (msg.sendStatus === 2) {
            sentMsgIds.delete(msg.msgId)
            this.ctx.parallel('nt/message-sent', msg)
          }
        }
      }
    })

    registerReceiveHook<{ msgRecord: RawMessage }>(ReceiveCmdS.SELF_SEND_MSG, payload => {
      sentMsgIds.set(payload.msgRecord.msgId, true)
    })

    const groupNotifyIgnore: string[] = []
    registerReceiveHook<{
      doubt: boolean
      oldestUnreadSeq: string
      unreadCount: number
    }>(ReceiveCmdS.UNREAD_GROUP_NOTIFY, async (payload) => {
      if (payload.unreadCount) {
        let notifies: GroupNotify[]
        try {
          notifies = await this.ctx.ntGroupApi.getSingleScreenNotifies(payload.doubt, payload.unreadCount)
        } catch (e) {
          return
        }
        for (const notify of notifies) {
          const notifyTime = Math.trunc(+notify.seq / 1000)
          if (groupNotifyIgnore.includes(notify.seq) || notifyTime < this.startTime) {
            continue
          }
          groupNotifyIgnore.push(notify.seq)
          this.ctx.parallel('nt/group-notify', { notify, doubt: payload.doubt })
        }
      }
    })

    registerReceiveHook<FriendRequestNotify>(ReceiveCmdS.FRIEND_REQUEST, payload => {
      for (const req of payload.data.buddyReqs) {
        if (!!req.isInitiator || (req.isDecide && req.reqType !== BuddyReqType.MeInitiatorWaitPeerConfirm)) {
          continue
        }
        if (+req.reqTime < this.startTime / 1000) {
          continue
        }
        this.ctx.parallel('nt/friend-request', req)
      }
    })

    invoke('nodeIKernelMsgListener/onRecvSysMsg', [], { registerEvent: true })

    registerReceiveHook<{
      msgBuf: number[]
    }>('nodeIKernelMsgListener/onRecvSysMsg', payload => {
      this.ctx.parallel('nt/system-message-created', Uint8Array.from(payload.msgBuf))
    })
  }
}

namespace Core {
  export interface Config extends LLOBConfig {
  }
}

export default Core
