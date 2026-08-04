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
    assert final.greeks is not None
    assert final.gamma_dynamics is not None
    assert final.gamma_dynamics_v2 is not None
    assert set(final.gamma_dynamics.inputs)=={"zomma","color","speed","gamma"}
    assert set(final.gamma_dynamics_v2.inputs)=={"zomma","color","speed","gamma","vomma","ultima"}
    assert {"delta","theta","vega","rho"}<=set(final.greeks.model_dump())
    assert all(f"greek_{name}" in final.supporting_indicators for name in ("delta","theta","vega","rho"))
    assert set(final.signal_checks)=={"explosion","direction","pressure_alignment","confidence","risk"}
    assert 0<=final.supporting_indicators["options_confidence"]<=1
