// Face screening with the multimodal model the workbench already uses (server/llm.ts).
// Seedance refuses photoreal faces as references, so a real face is caught here, before anything is paid for.
import { ask, image, parseJson, text } from '../../../server/llm';
import type { Guard } from '../types';

const ASK = `看这张用户上传的图片，只回答 JSON：{"face":"none|real|stylised","what":"一句话说明图里是什么"}。
face 的含义：none = 图里没有人脸（商品、衣服、风景等）；real = 有写实的人脸（真人照片，或写实到像真人的 AI 人像）；
stylised = 有人脸但明显是卡通、动漫、3D 角色、插画等非写实形象。`;

export const llmGuard: Guard = {
  name: '人脸检查（多模态模型）',
  async inspect(file) {
    try {
      const j = parseJson(await ask([text(ASK), image(file)], '你是素材审核助手，只输出 JSON。', 1));
      const face = ['none', 'real', 'stylised'].includes(j.face) ? j.face : 'unknown';
      return face === 'real'
        ? { ok: false, face, message: '图里有真人脸。视频模型会拦截写实人脸，建议换成卡通形象、虚拟模特或不含人脸的图片。' }
        : { ok: true, face, message: j.what };
    } catch (e: any) {
      return { ok: true, face: 'unknown', message: `没能完成人脸检查（${e.message}），会照常继续` };
    }
  }
};
