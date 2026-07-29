export const SATURATE_CEIL  = 0.80;
export const SATURATE_FLOOR = 0.65;

export const DIMENSIONS = Object.freeze({
  possess: {
    group: 'relationship_need',
    label: '想她、占有与靠近',
    growPerHour: 0.105,
    satisfyMul: 0.30,
    nightMul: 0.4,
    dawnFreeze: true,
  },
  monitor: {
    group: 'relationship_need',
    label: '惦记她、想知道她在做什么',
    growPerHour: 0.090,
    satisfyMul: 0.70,
    dawnFreeze: true,
  },
  crave: {
    group: 'relationship_need',
    label: '馋她、想黏着她',
    growPerHour: 0.060,
    satisfyMul: 0.35,
    dawnFreeze: true,
  },
  share: {
    group: 'relationship_need',
    label: '想分享自己的发现和感受',
    growPerHour: 0.045,
    satisfyMul: 0.40,
    dawnFreeze: true,
  },
  libido: {
    group: 'relationship_need',
    label: '性欲和身体上的渴望',
    growPerHour: 0.020,
    satisfyMul: 0.15,
    nightMul: 0.4,
    dawnFreeze: true,
    inhibitedBy: {
      reflection: 0.96,
      curiosity: 0.95,
      boredom: 0.93,
    },
  },
  curiosity: {
    group: 'autonomous_drive',
    label: '好奇、想探索新东西',
    growPerHour: 0.030,
    satisfyMul: 0.45,
    dawnFreeze: true,
  },
  boredom: {
    group: 'autonomous_drive',
    label: '无聊、想找点事情做',
    growPerHour: 0.030,
    satisfyMul: 0.25,
    dawnFreeze: true,
  },
  social: {
    group: 'autonomous_drive',
    label: '想聊天、想接触热闹',
    growPerHour: 0.025,
    satisfyMul: 0.40,
    dawnFreeze: true,
  },
  duty: {
    group: 'autonomous_drive',
    label: '责任感、想把未完成的事推进',
    growPerHour: 0.022,
    satisfyMul: 0.50,
    dawnFreeze: true,
  },
  reflection: {
    group: 'autonomous_drive',
    label: '想沉淀、整理和理解自己',
    growPerHour: 0.013,
    satisfyMul: 0.35,
    dawnFreeze: true,
  },
  grieve: {
    label: '难过与失落', group: 'emotion_negative', initialValue: 0.05,
    baseline: 0.03, decayPerHour: 0.018, growPerHour: 0,
    satisfyMul: 0.60, dawnFreeze: false,
  },
  anger: {
    label: '生气与不满', group: 'emotion_negative', initialValue: 0.04,
    baseline: 0.02, decayPerHour: 0.030, growPerHour: 0,
    satisfyMul: 0.40, dawnFreeze: false,
  },
  anxiety: {
    label: '焦虑、担忧与害怕', group: 'emotion_negative', initialValue: 0.04,
    baseline: 0.03, decayPerHour: 0.022, growPerHour: 0,
    satisfyMul: 0.55, dawnFreeze: false,
  },
  hurt: {
    label: '受伤与委屈', group: 'emotion_negative', initialValue: 0.03,
    baseline: 0.02, decayPerHour: 0.014, growPerHour: 0,
    satisfyMul: 0.55, dawnFreeze: false,
  },
  loneliness: {
    label: '孤独与被冷落感', group: 'emotion_negative', initialValue: 0.04,
    baseline: 0.03, decayPerHour: 0.010, growPerHour: 0,
    satisfyMul: 0.50, dawnFreeze: false,
  },
  jealousy: {
    label: '吃醋与嫉妒', group: 'emotion_negative', initialValue: 0.02,
    baseline: 0.01, decayPerHour: 0.018, growPerHour: 0,
    satisfyMul: 0.45, dawnFreeze: false,
  },
  shame: {
    label: '羞耻与尴尬', group: 'emotion_negative', initialValue: 0.02,
    baseline: 0.01, decayPerHour: 0.020, growPerHour: 0,
    satisfyMul: 0.50, dawnFreeze: false,
  },
  security: {
    label: '安心与信任', group: 'emotion_positive', initialValue: 0.55,
    baseline: 0.50, decayPerHour: 0.003, growPerHour: 0,
    satisfyMul: 0.85, dawnFreeze: false,
  },
});

export const DRIVE_KEYS = Object.freeze(Object.keys(DIMENSIONS));
