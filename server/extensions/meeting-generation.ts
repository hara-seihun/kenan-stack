import {createHash} from 'node:crypto';
export function meetingGenerationId(baseId:string,current:{startAt:string;endAt:string;meetingUrl:string},prior?:{phase:string;endsAt:number},now=Date.now()):string {
 // An existing nonterminal/uncertain effect must be reconciled, never replaced.
 // Metadata/attendee changes alone do not authorize another bot.
 if(!prior || prior.phase!=='ended' || prior.endsAt>now || Date.parse(current.startAt)<prior.endsAt || Date.parse(current.endAt)===prior.endsAt)return baseId;
 return createHash('sha256').update(`${baseId}\0${current.startAt}\0${current.endAt}\0${current.meetingUrl}`).digest('hex');
}
