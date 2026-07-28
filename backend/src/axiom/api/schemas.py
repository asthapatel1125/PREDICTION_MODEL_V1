from datetime import datetime

from pydantic import BaseModel,Field


class ReplayRequestBody(BaseModel):
    symbol:str=Field(min_length=1,max_length=16);start:datetime;end:datetime;bar_resolution_seconds:int=Field(gt=0);replay_speed:float=Field(default=0,ge=0)


class LiveEngineRequest(BaseModel):
    symbol:str=Field(min_length=1,max_length=16);resolution_seconds:int=Field(default=5,gt=0)


class HealthResponse(BaseModel):
    status:str;database:str;event_bus:str;version:str

