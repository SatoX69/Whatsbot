'use strict';

const { getEffectivePrefix } = require('../../lib/access');

function createEventHandler({
  socket,
  logger,
  eventManager,
  getConfig,
  getEventConfig,
  actionHandler
}) {
  let bound = false;

  const cooldowns = new Map();
  const bindings = [];

  const cfg = () => getEventConfig?.() || {};
  const config = () => getConfig?.() || {};
  const u = () => global.utils;

  function enabled(type) {
    const eventConfig = cfg();

    if (!type) return false;
    if (eventConfig.enabled === false || eventConfig.genericEvents === false) return false;

    if (type.startsWith('group.') && eventConfig.groupParticipantEvents === false) {
      return false;
    }

    if (type.startsWith('groups.') && eventConfig.groupEvents === false) {
      return false;
    }

    if (type === 'message.received' && eventConfig.messageReceivedEvents === false) {
      return false;
    }

    if (
      type.startsWith('message.') &&
      type !== 'message.received' &&
      eventConfig.messageEvents === false
    ) {
      return false;
    }

    if (type === 'presence.update' && eventConfig.presenceEvents !== true) {
      return false;
    }

    if (type.startsWith('chats.') && eventConfig.chatEvents !== true) {
      return false;
    }

    if (type.startsWith('contacts.') && eventConfig.contactEvents !== true) {
      return false;
    }

    if (type === 'message-receipt.update' && eventConfig.receiptEvents !== true) {
      return false;
    }

    if (type === 'message.reaction' && eventConfig.reactionEvents === false) {
      return false;
    }

    if (type === 'call' && eventConfig.callEvents !== true) {
      return false;
    }

    if (type.startsWith('blocklist.') && eventConfig.blocklistEvents !== true) {
      return false;
    }

    if (type.startsWith('labels.') && eventConfig.labelEvents !== true) {
      return false;
    }

    if (type === 'messages.media-update' && eventConfig.mediaEvents !== true) {
      return false;
    }

    return true;
  }

  function byMe(actorID, data, explicit = undefined) {
    if (typeof explicit === 'boolean') return explicit;

    const botID = socket.user?.id || config().botNumber;

    return Boolean(
      data?.fromMe ||
      data?.key?.fromMe ||
      (actorID && botID && u().sameUser(actorID, botID))
    );
  }

  function threadIDOf(raw, options) {
    return (
      options.threadID ||
      raw?.key?.remoteJid ||
      raw?.id ||
      raw?.jid ||
      null
    );
  }

  function toTimestamp(value) {
    const numeric = Number(value);

    if (!Number.isFinite(numeric) || numeric <= 0) {
      return Date.now();
    }

    return numeric < 1e12
      ? numeric * 1000
      : numeric;
  }

  function pruneCooldowns(maxAge) {
    const cutoff = Date.now() - Math.max(1000, Number(maxAge) || 3600000);

    for (const [key, timestamp] of cooldowns) {
      if (timestamp < cutoff) {
        cooldowns.delete(key);
      }
    }
  }

  function bindEvent(event, handler) {
    socket.ev.on(event, handler);
    bindings.push([event, handler]);
  }

  function unbindEvents() {
    if (typeof socket.ev.off !== 'function') {
      bindings.length = 0;
      return;
    }

    for (const [event, handler] of bindings.splice(0)) {
      try {
        socket.ev.off(event, handler);
      } catch {}
    }
  }

  function threadData() {
    return global.db?.threadsData || null;
  }

  function userData(userID) {
    try {
      return global.db?.usersData?.getSync?.(userID) || null;
    } catch {
      return null;
    }
  }

  function getCommands() {
    const commands = global.whatsbot?.commands;

    if (commands instanceof Map) {
      return [...commands.values()].flatMap(command =>
        Array.isArray(command) ? command : [command]
      );
    }

    if (Array.isArray(commands)) {
      return commands;
    }

    if (commands && typeof commands === 'object') {
      return Object.values(commands).flatMap(command =>
        Array.isArray(command) ? command : [command]
      );
    }

    return [];
  }

  function findReactionCommand(commandName, commands) {
    if (!commandName) return null;

    const direct = actionHandler.lookupCommand?.(commandName);

    if (direct && typeof direct.onReaction === 'function') {
      return direct;
    }

    return commands.find(command => (
      command?.config?.name === commandName &&
      typeof command?.onReaction === 'function'
    )) || null;
  }

  function removeReactionRegistration(onReaction, messageID, registration) {
    if (!(onReaction instanceof Map)) return;

    if (!onReaction.has(messageID)) return;

    const current = onReaction.get(messageID);

    if (!Array.isArray(current)) {
      onReaction.delete(messageID);
      return;
    }

    const remaining = current.filter(entry => entry !== registration);

    if (remaining.length) {
      onReaction.set(messageID, remaining);
    } else {
      onReaction.delete(messageID);
    }
  }

  async function dispatch(type, raw, options = {}) {
    const eventConfig = cfg();

    if (!enabled(type)) return null;

    const actorID = options.actorID || null;
    const self = byMe(actorID, options.data || raw, options.isSelf);

    if (eventConfig.eventByMe === false && self) {
      return null;
    }

    const threadID = threadIDOf(raw, options);

    if (
      eventConfig.ignoreStatus !== false &&
      threadID &&
      u().isStatus(threadID)
    ) {
      return null;
    }

    if (
      eventConfig.ignoreBroadcast !== false &&
      String(threadID || '').endsWith('@broadcast')
    ) {
      return null;
    }

    const cooldownMs = Number(eventConfig.cooldownMs || 0);

    if (cooldownMs > 0) {
      pruneCooldowns(Math.max(cooldownMs * 4, 3600000));

      const cooldownKey = `${type}:${threadID || '-'}`;
      const previous = cooldowns.get(cooldownKey) || 0;
      const now = Date.now();

      if (now - previous < cooldownMs) {
        return null;
      }

      cooldowns.set(cooldownKey, now);
    }

    let groupMetadata = options.groupMetadata || null;
    let threadName = options.threadName || null;

    if (threadID && u().isGroup(threadID) && !groupMetadata) {
      groupMetadata = await actionHandler.getGroupMetadata(threadID);
    }

    threadName ||= groupMetadata?.subject || groupMetadata?.name || null;

    const normalized = {
      type,
      eventType: type,

      messageID:
        options.messageID ||
        raw?.key?.id ||
        raw?.messageId ||
        null,

      senderID: actorID,
      actorID,

      threadID,
      threadName,

      participantID: options.participantID || null,

      body: String(options.body ?? '').trim(),

      repliedMessageID: options.repliedMessageID || null,
      repliedMessageBody: options.repliedMessageBody || '',
      repliedMessageSenderID: options.repliedMessageSenderID || null,

      isSelf: self,
      isByMe: self,

      isGroup: Boolean(threadID && u().isGroup(threadID)),
      isNewsletter: Boolean(threadID && u().isNewsletter(threadID)),
      isStatus: Boolean(threadID && u().isStatus(threadID)),

      pushName: options.pushName || null,
      mentions: options.mentions || [],
      messageType: options.messageType || null,
      contextInfo: options.contextInfo || null,

      targets: Array.isArray(options.targets)
        ? options.targets
        : [],

      timestamp: toTimestamp(options.timestamp),

      key: raw?.key || null,
      raw,
      data: options.data || raw,

      groupMetadata,

      ...(options.eventPatch || {})
    };

    const context = {
      api: null,
      message: null,

      event: normalized,
      eventType: type,

      actorID,
      targets: normalized.targets,
      data: normalized.data,

      socket,
      client: global.client,

      config: config(),

      usersData: global.db?.usersData,
      threadsData: global.db?.threadsData,
      localData: global.db?.localData,

      logger,
      log: logger,

      isByMe: normalized.isByMe
    };

    context.api = u().createApi({
      socket,
      rawMessage: options.message || null,
      chatJid: threadID,
      senderJid: actorID,
      event: normalized,
      isSelf: normalized.isSelf,

      trackOutgoing: actionHandler.trackOutgoing,
      getGroupMetadata: actionHandler.getGroupMetadata,
      isBotAdmin: actionHandler.isBotAdmin,
      isBotDev: actionHandler.isBotDev,
      isGroupAdmin: actionHandler.isGroupAdmin,

      groupMetadata
    });

    context.message = u().createMessage({
      rawMessage: options.message || null,
      chatJid: threadID,
      senderJid: actorID,
      messageKey: normalized.key || {},
      event: normalized,
      isSelf: normalized.isSelf,

      trackOutgoing: actionHandler.trackOutgoing,
      getGroupMetadata: actionHandler.getGroupMetadata,
      isBotAdmin: actionHandler.isBotAdmin,
      isBotDev: actionHandler.isBotDev,
      isGroupAdmin: actionHandler.isGroupAdmin
    }, context.api);

    for (const plugin of eventManager.events.values()) {
      if (!plugin?.config) continue;

      if (
        plugin.config.event !== '*' &&
        plugin.config.event !== type
      ) {
        continue;
      }

      if (typeof plugin.onEvent !== 'function') continue;

      try {
        await plugin.onEvent(context);
      } catch (error) {
        logger.error(
          'EVENT',
          `${plugin.config.name || type} failed`,
          error
        );
      }
    }

    return normalized;
  }

  async function dispatchReaction(update, commands) {
    const eventConfig = cfg();
    const onReaction = global.whatsbot?.onReaction;

    if (!(onReaction instanceof Map) || !onReaction.size) {
      return;
    }

    if (!enabled('message.reaction')) {
      return;
    }

    const targetKey = update?.key;
    const reaction = update?.reaction;

    if (!targetKey?.id || !reaction) {
      return;
    }

    const messageID = targetKey.id;

    if (!onReaction.has(messageID)) {
      return;
    }

    const registered = onReaction.get(messageID);

    if (!registered) {
      return;
    }

    const registrations = Array.isArray(registered)
      ? [...registered]
      : [registered];

    const threadID =
      targetKey.remoteJid ||
      targetKey.remoteJidAlt ||
      null;

    const actorKey = reaction?.key || {};

    const actorID = actorKey?.fromMe
      ? socket.user?.id || config().botNumber || null
      : actorKey?.participantAlt ||
        actorKey?.remoteJidAlt ||
        actorKey?.participant ||
        actorKey?.remoteJid ||
        null;

    const reactionText = String(reaction?.text || '');
    const removed = reactionText.length === 0;

    const targetSenderID =
      targetKey?.participantAlt ||
      targetKey?.participant ||
      targetKey?.remoteJid ||
      null;

    const actorUser = userData(actorID);

    const normalized = await dispatch(
      'message.reaction',
      update,
      {
        threadID,
        actorID,
        messageID,

        participantID: targetSenderID,

        body: reactionText,

        pushName:
          actorUser?.pushName ||
          actorUser?.username ||
          actorUser?.name ||
          null,

        messageType: 'reaction',
        timestamp:
          reaction?.timestamp ||
          update?.timestamp ||
          Date.now(),

        data: update,
        message: {
          ...update,
          key: targetKey,
          message: update?.message || {}
        },

        isSelf: Boolean(actorKey?.fromMe),

        targets: targetSenderID
          ? [targetSenderID]
          : [],

        eventPatch: {
          reaction: reactionText,
          reactionText,
          removed,

          reactionKey: actorKey,

          targetKey,
          targetMessageID: messageID,
          targetSenderID,

          participantID: targetSenderID
        }
      }
    );

    // monitor;; FIX
    normalized.type = "reaction";

    if (!normalized) {
      return;
    }

    const metadata = normalized.groupMetadata;
    const access = await actionHandler.getAccess(normalized, metadata);

    if (!access.allowed) {
      return;
    }

    const prefix = getEffectivePrefix(
      threadData(),
      global.db?.localData,
      threadID,
      config().prefix,
      u()
    );

    normalized.prefix = prefix;

    const reactionArgs = reactionText
      ? reactionText.split(/\s+/)
      : [];

    for (const registration of registrations) {
      const commandName =
        typeof registration === 'string'
          ? registration
          : registration?.commandName;

      if (!commandName) {
        logger.warn('ACTION', 'Reaction registration has no command name', {
          messageID,
          threadID,
          actorID
        });
        continue;
      }

      const command = findReactionCommand(commandName, commands);

      if (!command) {
        logger.debug('ACTION', 'Reaction command not found', {
          command: commandName,
          messageID,
          threadID,
          actorID
        });
        continue;
      }

      const commandConfig = command.config || {};
      const resolvedCommandName =
        commandConfig.name || commandName;

      const context = actionHandler.createContext({
        rawMessage: {
          ...update,
          key: targetKey,
          message: update?.message || {}
        },

        event: normalized,

        upsertType: 'notify',

        command,
        commandName: resolvedCommandName,

        args: reactionArgs,
        input: reactionText,

        prefix,

        groupMetadata: metadata,
        access
      });

      context.reaction = reactionText;
      context.reactionText = reactionText;
      context.removed = removed;
      // Reaction object
      context.Reaction = registered || {};
      context.reactionKey = actorKey;
      context.targetKey = targetKey;
      context.targetMessageID = messageID;
      context.targetSenderID = targetSenderID;

      context.reactionRegistration = registration;

      context.delete = () => {
        removeReactionRegistration(
          onReaction,
          messageID,
          registration
        );
      };

      if (!actionHandler.roleAllowed(commandConfig.role, context)) {
        continue;
      }

      const started = Date.now();

      try {
        if (typeof command.onReaction !== 'function') {
          continue;
        }

        await command.onReaction(context);

        logger.info(
          'ACTION',
          `onReaction ${resolvedCommandName} completed`,
          {
            messageID,
            threadID,
            actorID,

            reaction: reactionText,
            removed,

            args: context.args,

            role: Number(commandConfig.role || 0),

            durationMs: Date.now() - started
          }
        );
      } catch (error) {
        logger.error(
          'ACTION',
          `onReaction ${resolvedCommandName} failed`,
          error
        );
      }
    }

    if (eventConfig.eventByMe === false && normalized.isByMe) {
      return;
    }
  }

  function bind() {
    if (bound) return;

    bound = true;

    bindEvent(
      'group-participants.update',
      event => dispatch(
        `group.${event.action || 'unknown'}`,
        event,
        {
          threadID: event.id,
          actorID:
            event.authorPn ||
            event.author ||
            event.authorUsername ||
            null,
          targets: event.participants || [],
          data: event
        }
      ).catch(error => {
        logger.error(
          'EVENT',
          'group participant event failed',
          error
        );
      })
    );

    bindEvent(
      'groups.upsert',
      groups => Promise.all(
        (groups || []).map(group =>
          dispatch(
            'groups.upsert',
            group,
            {
              threadID: group.id,
              actorID: group.owner || null,
              data: group
            }
          ).catch(error => {
            logger.error('EVENT', 'groups.upsert failed', error);
          })
        )
      )
    );

    bindEvent(
      'groups.update',
      groups => Promise.all(
        (groups || []).map(group =>
          dispatch(
            'groups.update',
            group,
            {
              threadID: group.id,
              actorID:
                group.authorPn ||
                group.author ||
                null,
              data: group
            }
          ).catch(error => {
            logger.error('EVENT', 'groups.update failed', error);
          })
        )
      )
    );

    bindEvent(
      'messages.upsert',
      async ({ messages }) => {
        for (const message of messages || []) {
          const threadID = message?.key?.remoteJid || '';

          if (
            !threadID ||
            u().isStatus(threadID) ||
            String(threadID).endsWith('@broadcast')
          ) {
            continue;
          }

          const actorID = message?.key?.fromMe
            ? socket.user?.id || config().botNumber
            : message?.key?.participantAlt ||
              message?.key?.participant ||
              threadID;

          try {
            await dispatch(
              'message.received',
              message,
              {
                threadID,
                actorID,
                messageID: message?.key?.id || null,

                body: u().extractMessageText(
                  message?.message
                ),

                repliedMessageID:
                  u().quotedMessage(message)?.key?.id ||
                  null,

                message
              }
            );
          } catch (error) {
            logger.error(
              'EVENT',
              'message.received failed',
              error
            );
          }
        }
      }
    );

    bindEvent(
      'messages.update',
      updates => Promise.all(
        (updates || []).map(update =>
          dispatch(
            'message.update',
            update,
            {
              threadID: update?.key?.remoteJid,
              actorID:
                update?.key?.participantAlt ||
                update?.key?.participant ||
                null,
              data: update
            }
          )
        )
      ).catch(error => {
        logger.error(
          'EVENT',
          'messages.update failed',
          error
        );
      })
    );

    bindEvent(
      'messages.delete',
      update => Promise.all(
        (update?.keys || []).map(async key => {
          try {
            // no meed for this, I have a better plan
           // await global.db?.messagesData?.markDeleted?.(key.id);
          } catch {}

          await dispatch(
            'message.delete',
            update,
            {
              threadID: key.remoteJid,
              actorID:
                key.participantAlt ||
                key.participant ||
                null,
              data: {
                ...update,
                key
              }
            }
          );
        })
      ).catch(error => {
        logger.error(
          'EVENT',
          'messages.delete failed',
          error
        );
      })
    );

    bindEvent(
      'message-receipt.update',
      event => dispatch(
        'message-receipt.update',
        event,
        {
          threadID: event?.key?.remoteJid,
          actorID: event?.receipt?.userJid || null,
          data: event
        }
      ).catch(error => {
        logger.error(
          'EVENT',
          'receipt event failed',
          error
        );
      })
    );

    bindEvent(
      'presence.update',
      event => dispatch(
        'presence.update',
        event,
        {
          threadID: event?.id,
          actorID: event?.id,
          data: event
        }
      ).catch(error => {
        logger.debug(
          'EVENT',
          'presence event failed',
          error
        );
      })
    );

    bindEvent(
      'chats.upsert',
      event => dispatch(
        'chats.upsert',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'chats.update',
      event => dispatch(
        'chats.update',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'chats.delete',
      event => dispatch(
        'chats.delete',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'contacts.upsert',
      event => dispatch(
        'contacts.upsert',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'contacts.update',
      event => dispatch(
        'contacts.update',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'call',
      event => dispatch(
        'call',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'blocklist.set',
      event => dispatch(
        'blocklist.set',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'blocklist.update',
      event => dispatch(
        'blocklist.update',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'labels.edit',
      event => dispatch(
        'labels.edit',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'labels.association',
      event => dispatch(
        'labels.association',
        event,
        { data: event }
      ).catch(() => {})
    );

    bindEvent(
      'messages.reaction',
      async reactions => {
        const commands = getCommands();

        for (const update of reactions || []) {
          try {
            await dispatchReaction(update, commands);
          } catch (error) {
            logger.error(
              'EVENT',
              'messages.reaction item failed',
              error
            );
          }
        }
      }
    );

    bindEvent(
      'messages.upsert',
      async ({ messages }) => {
        const revokeType = global.client?.revokeType;

        if (revokeType === undefined) return;

        for (const message of messages || []) {
          const protocol =
            message?.message?.protocolMessage;

          if (
            !protocol ||
            protocol.type !== revokeType
          ) {
            continue;
          }

          const revokedKey = protocol.key;

          try {
            await dispatch(
              'message.unsent',
              message,
              {
                threadID:
                  revokedKey?.remoteJid ||
                  message.key?.remoteJid,

                actorID: message.key?.fromMe
                  ? socket.user?.id || config().botNumber
                  : message.key?.participant ||
                    message.key?.participantAlt ||
                    null,

                targets: revokedKey?.participant
                  ? [revokedKey.participant]
                  : [],

                data: {
                  protocol,
                  revokedKey,
                  fromMe: Boolean(
                    message.key?.fromMe
                  )
                },

                message
              }
            );
          } catch (error) {
            logger.error(
              'EVENT',
              'message.unsent failed',
              error
            );
          }
        }
      }
    );

    logger.info('EVENT', 'Event handler bound');
  }

  function shutdown() {
    unbindEvents();

    bound = false;
    cooldowns.clear();
  }

  return {
    bind,
    shutdown,
    dispatch
  };
}

module.exports = createEventHandler;