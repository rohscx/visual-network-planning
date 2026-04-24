from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class Allocation:
    cidr: str
    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Allocation":
        return cls(
            cidr=data["cidr"],
            name=data.get("name", ""),
            description=data.get("description", ""),
            tags=list(data.get("tags", [])),
        )


@dataclass
class Plan:
    name: str
    supernets: list[Allocation] = field(default_factory=list)
    allocations: list[Allocation] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "supernets": [s.to_dict() for s in self.supernets],
            "allocations": [a.to_dict() for a in self.allocations],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Plan":
        return cls(
            name=data["name"],
            supernets=[Allocation.from_dict(s) for s in data.get("supernets", [])],
            allocations=[Allocation.from_dict(a) for a in data.get("allocations", [])],
        )
