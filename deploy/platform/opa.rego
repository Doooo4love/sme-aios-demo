package aios

import rego.v1

default allow := false

in_scope if {
    input.actor.tenant == input.plan.tenant
    input.plan.warehouse in input.actor.warehouses
    input.plan.action in {"shipment.reschedule", "sales_order.create_draft"}
}

allow if {
    input.stage == "propose"
    in_scope
    input.actor.role in {"operator", "manager", "admin"}
}

allow if {
    input.stage == "approve"
    in_scope
    input.actor.role in {"manager", "admin"}
    input.actor.subject != input.requester
}
