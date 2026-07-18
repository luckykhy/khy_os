'use strict';

/**
 * structuredFurnace — 万物结构化熔炉引擎（DESIGN-ARCH-036）。
 *
 * 把无序/模糊/异构的自然语言强制坍缩为高维、严谨、机器零损解析的结构化意图，
 * 终结 Khyos 处理非结构化数据时的算力浪费与歧义。
 *
 * 对外单一导入面（Coordinator）。典型用法：
 *
 *     const furnace = require('./services/structuredFurnace');
 *     let env;
 *     try {
 *       env = furnace.intercept(userText);      // 前置拦截：NL → 封印信封
 *     } catch (e) {
 *       if (e instanceof furnace.FurnaceRejection) askHumanToClarify(e.toJSON());  // 拒损
 *       else throw e;
 *     }
 *     furnace.assertForged(env);                 // 业务侧消费前验封（§3.1 硬边界）
 *     // 之后只读 env.payload（ActionIntent/TaskGraph/StateMachine），永不碰原文。
 *
 * 三级坍缩协议：
 *   L0 降维打击  dimensionReducer.reduce        → ActionIntent
 *   L1 意图织网  intentWeaver.weave             → TaskGraph (DAG)
 *   L2 骨相重构  skeletonReconstructor.reconstruct → StateMachine
 * 路由由 entropyAssessor.assess 依输入熵自动决定；异常由 anomalyHandler 拒损/降级裁决；
 * 全流程经 chaosInterceptor 串联并 fail-closed 盖封。
 */

const entropyAssessor = require('./entropyAssessor');
const entityRegistry = require('./entityRegistry');
const taskGraph = require('./taskGraph');
const stateMachine = require('./stateMachine');
const forgeSchema = require('./forgeSchema');
const dimensionReducer = require('./dimensionReducer');
const intentWeaver = require('./intentWeaver');
const skeletonReconstructor = require('./skeletonReconstructor');
const anomalyHandler = require('./anomalyHandler');
const chaosInterceptor = require('./chaosInterceptor');

module.exports = {
  // —— 主入口（绝对前置拦截）——
  intercept: chaosInterceptor.intercept,
  assertForged: chaosInterceptor.assertForged,
  isForged: chaosInterceptor.isForged,
  SEAL_BRAND: chaosInterceptor.SEAL_BRAND,

  // —— 拒损异常 ——
  FurnaceRejection: anomalyHandler.FurnaceRejection,

  // —— 三级坍缩器（可单独调用，便于测试/特例）——
  reduce: dimensionReducer.reduce,
  weave: intentWeaver.weave,
  reconstruct: skeletonReconstructor.reconstruct,

  // —— 评估与裁决 ——
  assess: entropyAssessor.assess,
  adjudicate: anomalyHandler.adjudicate,
  validate: forgeSchema.validate,

  // —— 数据结构与规范（子模块整体再导出）——
  entropyAssessor,
  entityRegistry,
  EntityRegistry: entityRegistry.EntityRegistry,
  taskGraph,
  TaskGraph: taskGraph.TaskGraph,
  stateMachine,
  StateMachine: stateMachine.StateMachine,
  forgeSchema,
  dimensionReducer,
  intentWeaver,
  skeletonReconstructor,
  anomalyHandler,
  chaosInterceptor,
};
