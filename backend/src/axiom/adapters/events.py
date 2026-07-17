from __future__ import annotations

import asyncio
from collections import defaultdict


class InMemoryEventBus:
    def __init__(self,queue_size:int=4096):self.queue_size=queue_size;self._subscribers:dict[str,set[asyncio.Queue]]=defaultdict(set)

    async def publish(self,topic:str,payload:dict[str,object])->None:
        for queue in list(self._subscribers[topic]|self._subscribers["*"]):
            if queue.full():
                try:queue.get_nowait()
                except asyncio.QueueEmpty:pass
            await queue.put({"topic":topic,"payload":payload})

    def subscribe(self,topic:str="*")->asyncio.Queue:
        queue=asyncio.Queue(maxsize=self.queue_size);self._subscribers[topic].add(queue);return queue

    def unsubscribe(self,queue:asyncio.Queue,topic:str="*")->None:self._subscribers[topic].discard(queue)

