import { z } from 'zod';
import { bcp47LocaleSchema } from '../letters/index.js';

export const globalizationUiLocaleSchema = z.enum(['en', 'zh-Hans-CN', 'es-419', 'fr']);
export type GlobalizationUiLocale = z.infer<typeof globalizationUiLocaleSchema>;
export const globalizationUiLocales = globalizationUiLocaleSchema.options;

const contentLocalesSchema = z
  .array(bcp47LocaleSchema)
  .max(8)
  .transform((values) => [...new Set(values)]);

export const globalizationTimeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_+./-]+$/, 'time zone must be a PostgreSQL zone name');
export const globalizationHourCycleSchema = z.enum(['h11', 'h12', 'h23', 'h24']);
export const globalizationWeekStartSchema = z.number().int().min(0).max(6);

export const globalizationPreferencesRequestSchema = z
  .object({
    ui_locale: globalizationUiLocaleSchema,
    content_locales: contentLocalesSchema,
    time_zone: globalizationTimeZoneSchema,
    hour_cycle: globalizationHourCycleSchema,
    week_start: globalizationWeekStartSchema,
  })
  .strict();
export type GlobalizationPreferencesRequest = z.infer<typeof globalizationPreferencesRequestSchema>;

export const globalizationPreferencesSchema = globalizationPreferencesRequestSchema
  .extend({
    account_id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type GlobalizationPreferences = z.infer<typeof globalizationPreferencesSchema>;

const catalogMessageSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[<>]/.test(value), 'catalog messages must not contain markup');
const globalizationMessagesSchema = z
  .object({
    'common.nav.home': catalogMessageSchema,
    'common.nav.world': catalogMessageSchema,
    'common.nav.connect': catalogMessageSchema,
    'common.nav.circles': catalogMessageSchema,
    'common.nav.messages': catalogMessageSchema,
    'common.nav.me': catalogMessageSchema,
    'common.nav.notifications': catalogMessageSchema,
    'common.nav.writeLetter': catalogMessageSchema,
    'common.nav.settings': catalogMessageSchema,
    'common.nav.language': catalogMessageSchema,
    'home.eyebrow': catalogMessageSchema,
    'home.title': catalogMessageSchema,
    'home.description': catalogMessageSchema,
    'home.greeting': catalogMessageSchema,
    'world.title': catalogMessageSchema,
    'world.description': catalogMessageSchema,
    'world.empty': catalogMessageSchema,
    'world.action': catalogMessageSchema,
    'world.filters': catalogMessageSchema,
    'world.country': catalogMessageSchema,
    'world.language': catalogMessageSchema,
    'world.theme': catalogMessageSchema,
    'world.search': catalogMessageSchema,
    'world.refresh': catalogMessageSchema,
    'world.allThemes': catalogMessageSchema,
    'world.anyCountry': catalogMessageSchema,
    'world.searchPlaceholder': catalogMessageSchema,
    'messages.title': catalogMessageSchema,
    'messages.description': catalogMessageSchema,
    'messages.empty': catalogMessageSchema,
    'messages.action': catalogMessageSchema,
    'messages.connections': catalogMessageSchema,
    'messages.conversation': catalogMessageSchema,
    'messages.send': catalogMessageSchema,
    'messages.suggestDraft': catalogMessageSchema,
    'messages.inboxEyebrow': catalogMessageSchema,
    'messages.all': catalogMessageSchema,
    'messages.private': catalogMessageSchema,
    'messages.circles': catalogMessageSchema,
    'messages.search': catalogMessageSchema,
    'messages.noMatches': catalogMessageSchema,
    'messages.circleUnavailable': catalogMessageSchema,
    'messages.selectConversation': catalogMessageSchema,
    'messages.privateConversation': catalogMessageSchema,
    'messages.circleConversation': catalogMessageSchema,
    'messages.memberCount': catalogMessageSchema,
    'messages.openingLetter': catalogMessageSchema,
    'messages.backToInbox': catalogMessageSchema,
    'messages.block': catalogMessageSchema,
    'messages.report': catalogMessageSchema,
    'messages.withdraw': catalogMessageSchema,
    'messages.leaveCircle': catalogMessageSchema,
    'messages.writePlaceholder': catalogMessageSchema,
    'messages.circlePlaceholder': catalogMessageSchema,
    'messages.aiNotice': catalogMessageSchema,
    'messages.useDraft': catalogMessageSchema,
    'messages.discard': catalogMessageSchema,
    'messages.privacyDirect': catalogMessageSchema,
    'messages.privacyCircle': catalogMessageSchema,
    'messages.loading': catalogMessageSchema,
    'notifications.letter.received': catalogMessageSchema,
    'notifications.message.received': catalogMessageSchema,
    'notifications.connection.created': catalogMessageSchema,
    'notifications.introduction.available': catalogMessageSchema,
    'notifications.event.reminder': catalogMessageSchema,
    'notifications.circle.invitation': catalogMessageSchema,
    'notifications.safety.action_required': catalogMessageSchema,
    'settings.language.title': catalogMessageSchema,
    'settings.language.description': catalogMessageSchema,
    'settings.language.uiLocale': catalogMessageSchema,
    'settings.language.contentLocales': catalogMessageSchema,
    'settings.language.timeZone': catalogMessageSchema,
    'settings.language.hourCycle': catalogMessageSchema,
    'settings.language.weekStart': catalogMessageSchema,
    'settings.language.save': catalogMessageSchema,
    'settings.language.saved': catalogMessageSchema,
  })
  .strict();
const globalizationCatalogLocaleSchema = z
  .object({ direction: z.literal('ltr'), messages: globalizationMessagesSchema })
  .strict();
export const globalizationCatalogSchema = z
  .object({
    version: z.literal(1),
    locales: z
      .object({
        en: globalizationCatalogLocaleSchema,
        'zh-Hans-CN': globalizationCatalogLocaleSchema,
        'es-419': globalizationCatalogLocaleSchema,
        fr: globalizationCatalogLocaleSchema,
      })
      .strict(),
  })
  .strict();
export type GlobalizationCatalog = z.infer<typeof globalizationCatalogSchema>;

export interface GlobalizationRepositoryPort {
  read(accountId: string): Promise<GlobalizationPreferences | null>;
  replace(input: {
    accountId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestDigest: string;
    value: GlobalizationPreferencesRequest;
    now: Date;
  }): Promise<{ value: GlobalizationPreferences; replayed: boolean }>;
}

export const GLOBALIZATION_MESSAGE_KEYS = [
  'common.nav.home',
  'common.nav.world',
  'common.nav.connect',
  'common.nav.circles',
  'common.nav.messages',
  'common.nav.me',
  'common.nav.notifications',
  'common.nav.writeLetter',
  'common.nav.settings',
  'common.nav.language',
  'home.eyebrow',
  'home.title',
  'home.description',
  'home.greeting',
  'world.title',
  'world.description',
  'world.empty',
  'world.action',
  'world.filters',
  'world.country',
  'world.language',
  'world.theme',
  'world.search',
  'world.refresh',
  'world.allThemes',
  'world.anyCountry',
  'world.searchPlaceholder',
  'messages.title',
  'messages.description',
  'messages.empty',
  'messages.action',
  'messages.connections',
  'messages.conversation',
  'messages.send',
  'messages.suggestDraft',
  'messages.inboxEyebrow',
  'messages.all',
  'messages.private',
  'messages.circles',
  'messages.search',
  'messages.noMatches',
  'messages.circleUnavailable',
  'messages.selectConversation',
  'messages.privateConversation',
  'messages.circleConversation',
  'messages.memberCount',
  'messages.openingLetter',
  'messages.backToInbox',
  'messages.block',
  'messages.report',
  'messages.withdraw',
  'messages.leaveCircle',
  'messages.writePlaceholder',
  'messages.circlePlaceholder',
  'messages.aiNotice',
  'messages.useDraft',
  'messages.discard',
  'messages.privacyDirect',
  'messages.privacyCircle',
  'messages.loading',
  'notifications.letter.received',
  'notifications.message.received',
  'notifications.connection.created',
  'notifications.introduction.available',
  'notifications.event.reminder',
  'notifications.circle.invitation',
  'notifications.safety.action_required',
  'settings.language.title',
  'settings.language.description',
  'settings.language.uiLocale',
  'settings.language.contentLocales',
  'settings.language.timeZone',
  'settings.language.hourCycle',
  'settings.language.weekStart',
  'settings.language.save',
  'settings.language.saved',
] as const;
export type GlobalizationMessageKey = (typeof GLOBALIZATION_MESSAGE_KEYS)[number];

export const globalizationCatalog = {
  version: 1 as const,
  locales: {
    en: {
      direction: 'ltr' as const,
      messages: {
        'common.nav.home': 'Home',
        'common.nav.world': 'World',
        'common.nav.connect': 'Connect',
        'common.nav.circles': 'Circles',
        'common.nav.messages': 'Messages',
        'common.nav.me': 'Me',
        'common.nav.notifications': 'Notifications',
        'common.nav.writeLetter': 'Write a letter',
        'common.nav.settings': 'Settings',
        'common.nav.language': 'Language',
        'home.eyebrow': 'Letters from the world',
        'home.title': 'A slower way to meet.',
        'home.description':
          'Write a thoughtful letter, share a little of your world, and leave room for a real reply.',
        'home.greeting': 'Welcome, {name}',
        'world.title': 'World letters',
        'world.description': 'Discover thoughtful letters from around the world.',
        'world.empty': 'No letters to show yet.',
        'world.action': 'Explore the world',
        'world.filters': 'Letter filters',
        'world.country': 'Country',
        'world.language': 'Language',
        'world.theme': 'Theme',
        'world.search': 'Search',
        'world.refresh': 'Refresh shelf',
        'world.allThemes': 'All themes',
        'world.anyCountry': 'Any country',
        'world.searchPlaceholder': 'A place, feeling, or idea',
        'messages.title': 'Messages',
        'messages.description': 'Continue a conversation at your own pace.',
        'messages.empty': 'No active conversations yet.',
        'messages.action': 'Write a message',
        'messages.connections': 'Connections',
        'messages.conversation': 'Conversation',
        'messages.send': 'Send message',
        'messages.suggestDraft': 'Suggest a draft',
        'messages.inboxEyebrow': 'Private and circle conversations',
        'messages.all': 'All',
        'messages.private': 'Private',
        'messages.circles': 'Circles',
        'messages.search': 'Search conversations',
        'messages.noMatches': 'No conversations match this search.',
        'messages.circleUnavailable':
          'Circle conversations will appear here when group messaging is enabled.',
        'messages.selectConversation': 'Choose a conversation to continue at your own pace.',
        'messages.privateConversation': 'Private conversation',
        'messages.circleConversation': 'Circle conversation',
        'messages.memberCount': '{count} members',
        'messages.openingLetter': 'Opening private letter',
        'messages.backToInbox': 'Back to inbox',
        'messages.block': 'Block',
        'messages.report': 'Report',
        'messages.withdraw': 'Withdraw',
        'messages.leaveCircle': 'Leave circle',
        'messages.writePlaceholder': 'Write with care…',
        'messages.circlePlaceholder': 'Write to the circle…',
        'messages.aiNotice': 'AI suggestion · not sent',
        'messages.useDraft': 'Use draft',
        'messages.discard': 'Discard',
        'messages.privacyDirect': 'Only the two current participants can read this conversation.',
        'messages.privacyCircle': 'Only current circle members can read this conversation.',
        'messages.loading': 'Loading conversations…',
        'notifications.letter.received': 'You received a letter',
        'notifications.message.received': 'You have a new message',
        'notifications.connection.created': 'A new connection is available',
        'notifications.introduction.available': 'A new introduction is available',
        'notifications.event.reminder': 'You have an upcoming event',
        'notifications.circle.invitation': 'You were invited to a circle',
        'notifications.safety.action_required': 'A safety action needs your attention',
        'settings.language.title': 'Language and time',
        'settings.language.description':
          'Choose how Women AI Network speaks to you and how dates are shown.',
        'settings.language.uiLocale': 'Interface language',
        'settings.language.contentLocales': 'Content languages',
        'settings.language.timeZone': 'Time zone',
        'settings.language.hourCycle': 'Clock format',
        'settings.language.weekStart': 'Week starts on',
        'settings.language.save': 'Save preferences',
        'settings.language.saved': 'Preferences saved.',
      },
    },
    'zh-Hans-CN': {
      direction: 'ltr' as const,
      messages: {
        'common.nav.home': '首页',
        'common.nav.world': '世界',
        'common.nav.connect': '联系',
        'common.nav.circles': '圈子',
        'common.nav.messages': '聊天',
        'common.nav.me': '我的',
        'common.nav.notifications': '通知',
        'common.nav.writeLetter': '写一封信',
        'common.nav.settings': '设置',
        'common.nav.language': '语言',
        'home.eyebrow': '来自世界的信',
        'home.title': '用更从容的方式相遇。',
        'home.description': '写一封真诚的信，分享你的世界，也为真正的回信留出空间。',
        'home.greeting': '欢迎，{name}',
        'world.title': '世界来信',
        'world.description': '发现来自世界各地的真诚来信。',
        'world.empty': '暂时没有可展示的信件。',
        'world.action': '探索世界',
        'world.filters': '信件筛选',
        'world.country': '国家',
        'world.language': '语言',
        'world.theme': '主题',
        'world.search': '搜索',
        'world.refresh': '刷新信架',
        'world.allThemes': '所有主题',
        'world.anyCountry': '任意国家',
        'world.searchPlaceholder': '地点、感受或想法',
        'messages.title': '消息',
        'messages.description': '按照自己的节奏继续对话。',
        'messages.empty': '暂时没有进行中的对话。',
        'messages.action': '写消息',
        'messages.connections': '连接',
        'messages.conversation': '对话',
        'messages.send': '发送消息',
        'messages.suggestDraft': '建议草稿',
        'messages.inboxEyebrow': '私人消息与圈子对话',
        'messages.all': '全部',
        'messages.private': '私人消息',
        'messages.circles': '圈子群聊',
        'messages.search': '搜索对话',
        'messages.noMatches': '没有符合搜索条件的对话。',
        'messages.circleUnavailable': '启用圈子群聊后，对话会显示在这里。',
        'messages.selectConversation': '选择一段对话，按照自己的节奏继续交流。',
        'messages.privateConversation': '私人对话',
        'messages.circleConversation': '圈子对话',
        'messages.memberCount': '{count} 位成员',
        'messages.openingLetter': '开场私人信',
        'messages.backToInbox': '返回消息列表',
        'messages.block': '屏蔽',
        'messages.report': '举报',
        'messages.withdraw': '撤回',
        'messages.leaveCircle': '退出圈子',
        'messages.writePlaceholder': '认真写下你的话……',
        'messages.circlePlaceholder': '写给圈子成员……',
        'messages.aiNotice': 'AI 建议 · 尚未发送',
        'messages.useDraft': '使用草稿',
        'messages.discard': '放弃',
        'messages.privacyDirect': '只有当前两位参与者可以阅读这段对话。',
        'messages.privacyCircle': '只有当前圈子成员可以阅读这段对话。',
        'messages.loading': '正在加载对话……',
        'notifications.letter.received': '你收到了一封信',
        'notifications.message.received': '你有一条新消息',
        'notifications.connection.created': '有一个新的连接',
        'notifications.introduction.available': '有一个新的介绍',
        'notifications.event.reminder': '你有一个即将到来的活动',
        'notifications.circle.invitation': '你收到圈子邀请',
        'notifications.safety.action_required': '有一项安全操作需要你的注意',
        'settings.language.title': '语言与时间',
        'settings.language.description':
          '选择 Women AI Network 与你交流的语言，以及日期的显示方式。',
        'settings.language.uiLocale': '界面语言',
        'settings.language.contentLocales': '内容语言',
        'settings.language.timeZone': '时区',
        'settings.language.hourCycle': '时钟格式',
        'settings.language.weekStart': '每周开始于',
        'settings.language.save': '保存偏好',
        'settings.language.saved': '偏好已保存。',
      },
    },
    'es-419': {
      direction: 'ltr' as const,
      messages: {
        'common.nav.home': 'Inicio',
        'common.nav.world': 'Mundo',
        'common.nav.connect': 'Conectar',
        'common.nav.circles': 'Círculos',
        'common.nav.messages': 'Mensajes',
        'common.nav.me': 'Yo',
        'common.nav.notifications': 'Notificaciones',
        'common.nav.writeLetter': 'Escribir una carta',
        'common.nav.settings': 'Configuración',
        'common.nav.language': 'Idioma',
        'home.eyebrow': 'Cartas del mundo',
        'home.title': 'Una forma más pausada de conocernos.',
        'home.description':
          'Escribe una carta con intención, comparte un poco de tu mundo y deja espacio para una respuesta real.',
        'home.greeting': 'Te damos la bienvenida, {name}',
        'world.title': 'Cartas del mundo',
        'world.description': 'Descubre cartas con intención de todo el mundo.',
        'world.empty': 'Aún no hay cartas para mostrar.',
        'world.action': 'Explorar el mundo',
        'world.filters': 'Filtros de cartas',
        'world.country': 'País',
        'world.language': 'Idioma',
        'world.theme': 'Tema',
        'world.search': 'Buscar',
        'world.refresh': 'Actualizar estante',
        'world.allThemes': 'Todos los temas',
        'world.anyCountry': 'Cualquier país',
        'world.searchPlaceholder': 'Lugar, sentimiento o idea',
        'messages.title': 'Mensajes',
        'messages.description': 'Continúa una conversación a tu propio ritmo.',
        'messages.empty': 'Aún no hay conversaciones activas.',
        'messages.action': 'Escribir un mensaje',
        'messages.connections': 'Conexiones',
        'messages.conversation': 'Conversación',
        'messages.send': 'Enviar mensaje',
        'messages.suggestDraft': 'Sugerir un borrador',
        'messages.inboxEyebrow': 'Conversaciones privadas y de círculos',
        'messages.all': 'Todo',
        'messages.private': 'Privadas',
        'messages.circles': 'Círculos',
        'messages.search': 'Buscar conversaciones',
        'messages.noMatches': 'Ninguna conversación coincide con la búsqueda.',
        'messages.circleUnavailable':
          'Las conversaciones de círculos aparecerán aquí cuando se active la mensajería grupal.',
        'messages.selectConversation': 'Elige una conversación y continúa a tu propio ritmo.',
        'messages.privateConversation': 'Conversación privada',
        'messages.circleConversation': 'Conversación de círculo',
        'messages.memberCount': '{count} integrantes',
        'messages.openingLetter': 'Carta privada inicial',
        'messages.backToInbox': 'Volver a mensajes',
        'messages.block': 'Bloquear',
        'messages.report': 'Denunciar',
        'messages.withdraw': 'Retirar',
        'messages.leaveCircle': 'Salir del círculo',
        'messages.writePlaceholder': 'Escribe con cuidado…',
        'messages.circlePlaceholder': 'Escribe al círculo…',
        'messages.aiNotice': 'Sugerencia de IA · no enviada',
        'messages.useDraft': 'Usar borrador',
        'messages.discard': 'Descartar',
        'messages.privacyDirect':
          'Solo las dos participantes actuales pueden leer esta conversación.',
        'messages.privacyCircle': 'Solo las integrantes actuales del círculo pueden leerla.',
        'messages.loading': 'Cargando conversaciones…',
        'notifications.letter.received': 'Has recibido una carta',
        'notifications.message.received': 'Tienes un mensaje nuevo',
        'notifications.connection.created': 'Hay una nueva conexión disponible',
        'notifications.introduction.available': 'Hay una nueva introducción disponible',
        'notifications.event.reminder': 'Tienes un evento próximo',
        'notifications.circle.invitation': 'Has recibido una invitación a un círculo',
        'notifications.safety.action_required': 'Una acción de seguridad requiere tu atención',
        'settings.language.title': 'Idioma y hora',
        'settings.language.description':
          'Elige cómo Women AI Network te habla y cómo se muestran las fechas.',
        'settings.language.uiLocale': 'Idioma de la interfaz',
        'settings.language.contentLocales': 'Idiomas del contenido',
        'settings.language.timeZone': 'Zona horaria',
        'settings.language.hourCycle': 'Formato del reloj',
        'settings.language.weekStart': 'La semana comienza el',
        'settings.language.save': 'Guardar preferencias',
        'settings.language.saved': 'Preferencias guardadas.',
      },
    },
    fr: {
      direction: 'ltr' as const,
      messages: {
        'common.nav.home': 'Accueil',
        'common.nav.world': 'Monde',
        'common.nav.connect': 'Rencontres',
        'common.nav.circles': 'Cercles',
        'common.nav.messages': 'Messages',
        'common.nav.me': 'Moi',
        'common.nav.notifications': 'Notifications',
        'common.nav.writeLetter': 'Écrire une lettre',
        'common.nav.settings': 'Réglages',
        'common.nav.language': 'Langue',
        'home.eyebrow': 'Lettres du monde',
        'home.title': 'Une façon plus douce de se rencontrer.',
        'home.description':
          'Écrivez une lettre sincère, partagez un peu de votre monde et laissez place à une vraie réponse.',
        'home.greeting': 'Bienvenue, {name}',
        'world.title': 'Lettres du monde',
        'world.description': 'Découvrez des lettres sincères venues du monde entier.',
        'world.empty': 'Aucune lettre à afficher pour le moment.',
        'world.action': 'Explorer le monde',
        'world.filters': 'Filtres des lettres',
        'world.country': 'Pays',
        'world.language': 'Langue',
        'world.theme': 'Thème',
        'world.search': 'Rechercher',
        'world.refresh': 'Actualiser la sélection',
        'world.allThemes': 'Tous les thèmes',
        'world.anyCountry': 'Tous les pays',
        'world.searchPlaceholder': 'Lieu, émotion ou idée',
        'messages.title': 'Messages',
        'messages.description': 'Poursuivez une conversation à votre rythme.',
        'messages.empty': 'Aucune conversation active pour le moment.',
        'messages.action': 'Écrire un message',
        'messages.connections': 'Connexions',
        'messages.conversation': 'Conversation',
        'messages.send': 'Envoyer le message',
        'messages.suggestDraft': 'Suggérer un brouillon',
        'messages.inboxEyebrow': 'Conversations privées et de cercles',
        'messages.all': 'Toutes',
        'messages.private': 'Privées',
        'messages.circles': 'Cercles',
        'messages.search': 'Rechercher des conversations',
        'messages.noMatches': 'Aucune conversation ne correspond à cette recherche.',
        'messages.circleUnavailable':
          'Les conversations de cercle apparaîtront ici lorsque la messagerie de groupe sera activée.',
        'messages.selectConversation': 'Choisissez une conversation et avancez à votre rythme.',
        'messages.privateConversation': 'Conversation privée',
        'messages.circleConversation': 'Conversation de cercle',
        'messages.memberCount': '{count} membres',
        'messages.openingLetter': 'Lettre privée initiale',
        'messages.backToInbox': 'Retour aux messages',
        'messages.block': 'Bloquer',
        'messages.report': 'Signaler',
        'messages.withdraw': 'Retirer',
        'messages.leaveCircle': 'Quitter le cercle',
        'messages.writePlaceholder': 'Écrivez avec attention…',
        'messages.circlePlaceholder': 'Écrivez au cercle…',
        'messages.aiNotice': 'Suggestion IA · non envoyée',
        'messages.useDraft': 'Utiliser le brouillon',
        'messages.discard': 'Ignorer',
        'messages.privacyDirect':
          'Seules les deux participantes actuelles peuvent lire cette conversation.',
        'messages.privacyCircle': 'Seules les membres actuelles du cercle peuvent la lire.',
        'messages.loading': 'Chargement des conversations…',
        'notifications.letter.received': 'Vous avez reçu une lettre',
        'notifications.message.received': 'Vous avez un nouveau message',
        'notifications.connection.created': 'Une nouvelle connexion est disponible',
        'notifications.introduction.available': 'Une nouvelle introduction est disponible',
        'notifications.event.reminder': 'Vous avez un événement à venir',
        'notifications.circle.invitation': 'Vous avez reçu une invitation à un cercle',
        'notifications.safety.action_required': 'Une action de sécurité nécessite votre attention',
        'settings.language.title': 'Langue et heure',
        'settings.language.description':
          'Choisissez la langue de Women AI Network et l’affichage des dates.',
        'settings.language.uiLocale': 'Langue de l’interface',
        'settings.language.contentLocales': 'Langues du contenu',
        'settings.language.timeZone': 'Fuseau horaire',
        'settings.language.hourCycle': 'Format de l’horloge',
        'settings.language.weekStart': 'La semaine commence le',
        'settings.language.save': 'Enregistrer les préférences',
        'settings.language.saved': 'Préférences enregistrées.',
      },
    },
  },
} satisfies GlobalizationCatalog;

export function resolveUiLocale(requested: string): GlobalizationUiLocale {
  if (globalizationUiLocaleSchema.options.includes(requested as GlobalizationUiLocale)) {
    return requested as GlobalizationUiLocale;
  }
  const base = requested.split('-')[0]?.toLowerCase();
  if (base === 'zh') return 'zh-Hans-CN';
  if (base === 'es') return 'es-419';
  if (base === 'fr') return 'fr';
  return 'en';
}

export function formatGlobalizationMessage(
  requestedLocale: string,
  key: GlobalizationMessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const locale = resolveUiLocale(requestedLocale);
  const template =
    globalizationCatalog.locales[locale].messages[key] ??
    globalizationCatalog.locales.en.messages[key];
  if (template === undefined) return key;
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

export function assertCompleteGlobalizationCatalog(catalog: GlobalizationCatalog): void {
  for (const locale of globalizationUiLocales) {
    for (const key of GLOBALIZATION_MESSAGE_KEYS) {
      if (typeof catalog.locales[locale]?.messages[key] !== 'string') {
        throw new Error(`missing globalization message: ${locale}:${key}`);
      }
    }
  }
}

assertCompleteGlobalizationCatalog(globalizationCatalog);
