from axiom.application.pipeline import DecisionPipeline
from axiom.domain.enums import EngineMode

from conftest import make_bar


def test_pipeline_is_deterministic(config):
    one,two=DecisionPipeline(config),DecisionPipeline(config)
    results_one=[one.process(make_bar(i),EngineMode.TRAINING) for i in range(140)]
    results_two=[two.process(make_bar(i),EngineMode.LIVE) for i in range(140)]
    for a,b in zip(results_one,results_two):
        assert a.state.model_dump()==b.state.model_dump()
        assert (a.alert is None)==(b.alert is None)
        if a.alert and b.alert:
            assert a.alert.model_dump(exclude={"id","engine_mode"})==b.alert.model_dump(exclude={"id","engine_mode"})
    final=results_one[-1].state
    assert set(final.signal_checks)=={"explosion","direction","pressure_alignment","confidence","risk"}
    assert 0<=final.supporting_indicators["options_confidence"]<=1
