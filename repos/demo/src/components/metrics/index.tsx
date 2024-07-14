import BaseMetric from "./BaseMetric"
import { BaseAggregatorData } from "../../lib/internal/aggregator/base"
import type { AggregatorData } from "../../lib/internal/types"

const Metrics = Object.keys(BaseAggregatorData).map((key) => <BaseMetric metric={key as keyof AggregatorData} />)

export default Metrics
