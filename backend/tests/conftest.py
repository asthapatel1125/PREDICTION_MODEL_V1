import os
from datetime import datetime,timedelta,timezone

os.environ.setdefault(
    "SUPABASE_DATABASE_URL",
    "postgresql://postgres.test:password@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require",
)

import pytest

from axiom.config.schema import StrategyConfig
from axiom.domain.models import Greeks,MarketBar


@pytest.fixture
def config()->StrategyConfig:return StrategyConfig.from_yaml("config/strategy.yaml")


def make_bar(index:int,symbol:str="QQQ")->MarketBar:
    direction=1 if index%9 else -1;energy=1+3*(index%17>12);price=480+index*.04
    return MarketBar(timestamp=datetime(2026,7,15,13,30,tzinfo=timezone.utc)+timedelta(seconds=5*index),symbol=symbol,timeframe_seconds=5,
        open=price-.02,high=price+.04,low=price-.05,close=price,volume=1000+index*5,bid_ask_spread=.02,
        greeks=Greeks(gamma=.08*direction*energy,vanna=.11*direction*energy,charm=.09*direction*energy,vomma=.2*energy,
            veta=-.07*energy,speed=.13*energy,zomma=.12*energy,color=.16*energy,ultima=.22*energy))
