function Damage() {}

Damage.prototype.Schema =
	"<a:component type='system'/><empty/>";

Damage.prototype.Init = function()
{
};

/**
 * Gives the position of the given entity, taking the lateness into account.
 * @param {number} ent - entity id of the entity we are finding the location for.
 * @param {number} lateness - the time passed since the expected time to fire the function.
 * @return {Vector3D} - the location of the entity.
 */
Damage.prototype.InterpolatedLocation = function(ent, lateness)
{
	let cmpTargetPosition = Engine.QueryInterface(ent, IID_Position);
	if (!cmpTargetPosition || !cmpTargetPosition.IsInWorld()) // TODO: handle dead target properly
		return undefined;
	let curPos = cmpTargetPosition.GetPosition();
	let prevPos = cmpTargetPosition.GetPreviousPosition();
	let cmpTimer = Engine.QueryInterface(SYSTEM_ENTITY, IID_Timer);
	let turnLength = cmpTimer.GetLatestTurnLength();
	return new Vector3D(
			(curPos.x * (turnLength - lateness) + prevPos.x * lateness) / turnLength,
			0,
			(curPos.z * (turnLength - lateness) + prevPos.z * lateness) / turnLength);
};

/**
 * Test if a point is inside of an entity's footprint.
 * @param {number}   ent - id of the entity we are checking with.
 * @param {Vector3D} point - the point we are checking with.
 * @param {number}   lateness - the time passed since the expected time to fire the function.
 * @return {boolean} - true if the point is inside of the entity's footprint.
 */
Damage.prototype.TestCollision = function(ent, point, lateness)
{
	let targetPosition = this.InterpolatedLocation(ent, lateness);
	if (!targetPosition)
		return false;

	let cmpFootprint = Engine.QueryInterface(ent, IID_Footprint);
	if (!cmpFootprint)
		return false;

	let targetShape = cmpFootprint.GetShape();

	if (!targetShape)
		return false;

	if (targetShape.type == "circle")
		return targetPosition.horizDistanceToSquared(point) < targetShape.radius * targetShape.radius;

	if (targetShape.type == "square")
	{
		let angle = Engine.QueryInterface(ent, IID_Position).GetRotation().y;
		let distance = Vector2D.from3D(Vector3D.sub(point, targetPosition)).rotate(-angle);
		return Math.abs(distance.x) < targetShape.width / 2 && Math.abs(distance.y) < targetShape.depth / 2;
	}

	warn("TestCollision called with an invalid footprint shape");
	return false;
};

/**
 * Get the list of players affected by the damage.
 * @param {number}  attackerOwner - the player id of the attacker.
 * @param {boolean} friendlyFire - a flag indicating if allied entities are also damaged.
 * @return {number[]} - the ids of players need to be damaged
 */
Damage.prototype.GetPlayersToDamage = function(attackerOwner, friendlyFire)
{
	if (!friendlyFire)
		return QueryPlayerIDInterface(attackerOwner).GetEnemies();

	return Engine.QueryInterface(SYSTEM_ENTITY, IID_PlayerManager).GetAllPlayers();
};

/**
 * Handles hit logic after the projectile travel time has passed.
 * @param {Object}   data - the data sent by the caller.
 * @param {number}   data.attacker - the entity id of the attacker.
 * @param {number}   data.target - the entity id of the target.
 * @param {Vector2D} data.origin - the origin of the projectile hit.
 * @param {Object}   data.strengths - data of the form { 'hack': number, 'pierce': number, 'crush': number }.
 * @param {string}   data.type - the type of damage.
 * @param {number}   data.attackerOwner - the player id of the owner of the attacker.
 * @param {boolean}  data.isSplash - a flag indicating if it's splash damage.
 * @param {Vector3D} data.position - the expected position of the target.
 * @param {number}   data.projectileId - the id of the projectile.
 * @param {Vector3D} data.direction - the unit vector defining the direction.
 * @param {Object}   data.bonus - the attack bonus template from the attacker.
 * @param {string}   data.attackImpactSound - the name of the sound emited on impact.
 * ***When splash damage***
 * @param {boolean}  data.friendlyFire - a flag indicating if allied entities are also damaged.
 * @param {number}   data.radius - the radius of the splash damage.
 * @param {string}   data.shape - the shape of the splash range.
 * @param {Object}   data.splashBonus - the attack bonus template from the attacker.
 * @param {Object}   data.splashStrengths - data of the form { 'hack': number, 'pierce': number, 'crush': number }.
 */
Damage.prototype.MissileHit = function(data, lateness)
{
	if (!data.position)
		return;

	let cmpSoundManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_SoundManager);
	if (cmpSoundManager && data.attackImpactSound)
		cmpSoundManager.PlaySoundGroupAtPosition(data.attackImpactSound, data.position);

	// Do this first in case the direct hit kills the target
	if (data.isSplash)
	{
		this.CauseSplashDamage({
			"attacker": data.attacker,
			"origin": Vector2D.from3D(data.position),
			"radius": data.radius,
			"shape": data.shape,
			"strengths": data.splashStrengths,
			"splashBonus": data.splashBonus,
			"direction": data.direction,
			"playersToDamage": this.GetPlayersToDamage(data.attackerOwner, data.friendlyFire),
			"type": data.type,
			"attackerOwner": data.attackerOwner,
			"fire": data.splashFire
		});
	}

	let cmpProjectileManager = Engine.QueryInterface(SYSTEM_ENTITY, IID_ProjectileManager);

	// Deal direct damage if we hit the main target
	// and if the target has DamageReceiver (not the case for a mirage for example)
	let cmpDamageReceiver = Engine.QueryInterface(data.target, IID_DamageReceiver);
	if (cmpDamageReceiver && this.TestCollision(data.target, data.position, lateness))
	{
		let flank = 0;

		let cmpTargetPosition = Engine.QueryInterface(data.target, IID_Position);

		if (!cmpTargetPosition || !cmpTargetPosition.IsInWorld())
			return;

		let selfRotation = data.direction.y;
		let targetRotation = cmpTargetPosition.GetRotation().y;

		let backAngleToleration = 2.0;

		let angleDiff = (selfRotation - targetRotation) % (2 * Math.PI);

		if (angleDiff < 0.0)
			angleDiff = angleDiff * (-1.0);
		if (angleDiff < backAngleToleration)
			flank = 1;

		data.multiplier = GetDamageBonus(data.target, data.bonus);
		//this.CauseDamage(data);
		this.CauseDamage({
			"strengths": data.strengths,
			"target": data.target,
			"attacker": data.attacker,
			"multiplier": data.multiplier,
			"type": data.type,
			"attackerOwner": data.attackerOwner,
			"critDamage": data.critDamage,
			"flank": flank,
			"fire": data.fire
		});
		cmpProjectileManager.RemoveProjectile(data.projectileId);
		return;
	}

	let targetPosition = this.InterpolatedLocation(data.target, lateness);
	if (!targetPosition)
		return;

	// If we didn't hit the main target look for nearby units
	let cmpPlayer = QueryPlayerIDInterface(data.attackerOwner);
	let ents = this.EntitiesNearPoint(Vector2D.from3D(data.position), targetPosition.horizDistanceTo(data.position) * 2, this.GetPlayersToDamage(data.attackerOwner, data.friendlyFire));
	for (let ent of ents)
	{
		if (!this.TestCollision(ent, data.position, lateness))
			continue;

		let flank = 0;

		let cmpTargetPosition = Engine.QueryInterface(ent, IID_Position);

		if (!cmpTargetPosition || !cmpTargetPosition.IsInWorld())
			continue;

		let selfRotation = data.direction.y;
		let targetRotation = cmpTargetPosition.GetRotation().y;

		let backAngleToleration = 2.0;

		let angleDiff = (selfRotation - targetRotation) % (2 * Math.PI);

		if (angleDiff < 0.0)
			angleDiff = angleDiff * (-1.0);
		if (angleDiff < backAngleToleration)
			flank = 1;

		this.CauseDamage({
			"strengths": data.strengths,
			"target": ent,
			"attacker": data.attacker,
			"multiplier": GetDamageBonus(ent, data.bonus),
			"type": data.type,
			"attackerOwner": data.attackerOwner,
			"critDamage": data.critDamage,
			"flank": flank,
			"fire": data.fire
		});
		cmpProjectileManager.RemoveProjectile(data.projectileId);
		break;
	}
};

Damage.prototype.CauseChargeDamage = function(data)
{
//	warn("Causing charge damage");
	let origin = Vector2D.from3D(data.position);
	let playersToDamage = this.GetPlayersToDamage(data.attackerOwner, false);
	let nearEnts = this.EntitiesNearPoint(origin, data.radius, playersToDamage);
	let direction = data.direction;
	let damageMultiplier = 4;
	let attacker = data.attacker;

	let cmpHealth = Engine.QueryInterface(data.attacker, IID_Health);
	for (let ent of nearEnts)
	{
		let flank = 0;
		let target = ent;
		let cmpTargetPosition = Engine.QueryInterface(target, IID_Position);
		let cmpPosition = Engine.QueryInterface(attacker, IID_Position);
		if (!cmpPosition || !cmpPosition.IsInWorld())
			return;

		if (!cmpTargetPosition || !cmpTargetPosition.IsInWorld())
			return;

		let selfRotation = cmpPosition.GetRotation().y;
		let targetRotation = cmpTargetPosition.GetRotation().y;

		let backAngleToleration = 1.0;
		let sideAngleToleration = 2.0;

		let angleDiff = (selfRotation - targetRotation) % (2 * Math.PI);

		if (angleDiff < 0.0)
			angleDiff = angleDiff * (-1.0);
		if (angleDiff < backAngleToleration)
			flank = 1;
		else if (angleDiff < sideAngleToleration)
			flank = 0.5;

		if (!flank) {
			let cmpUnitAI = Engine.QueryInterface(target, IID_UnitAI);
			if (cmpUnitAI && cmpUnitAI.IsFormationMember() && cmpUnitAI.IsAntiCharge()) {
				let cmpAttack = Engine.QueryInterface(target, IID_Attack);
				if (cmpAttack && cmpAttack.CanCauseAntiCharge()) {
					cmpAttack.PerformAntiChargeDamage(data.attacker);
					if (cmpHealth.GetHitpoints() <= 0.0)
						break;
				}
			}
		}
		let entityPosition = Engine.QueryInterface(ent, IID_Position).GetPosition2D();
		damageMultiplier = 1 - origin.distanceToSquared(entityPosition) / (data.radius * data.radius);

		if (data.bonusTemplate)
			damageMultiplier *= GetDamageBonus(ent, data.bonusTemplate);

		this.CauseDamage({
			"strengths": data.strengths,
			"target": ent,
			"attacker": data.attacker,
			"multiplier": damageMultiplier,
			"type": data.type,
			"attackerOwner": data.attackerOwner,
			"flank": flank,
			"charge": 1
		});
	}
}

/**
 * Damages units around a given origin.
 * @param {Object}   data - the data sent by the caller.
 * @param {number}   data.attacker - the entity id of the attacker.
 * @param {Vector2D} data.origin - the origin of the projectile hit.
 * @param {number}   data.radius - the radius of the splash damage.
 * @param {string}   data.shape - the shape of the radius.
 * @param {Object}   data.strengths - data of the form { 'hack': number, 'pierce': number, 'crush': number }.
 * @param {string}   data.type - the type of damage.
 * @param {number}   data.attackerOwner - the player id of the attacker.
 * @param {Vector3D} [data.direction] - the unit vector defining the direction. Needed for linear splash damage.
 * @param {Object}   data.splashBonus - the attack bonus template from the attacker.
 * @param {number[]} data.playersToDamage - the array of player id's to damage.
 */
Damage.prototype.CauseSplashDamage = function(data)
{
	// Get nearby entities and define variables
	let nearEnts = this.EntitiesNearPoint(data.origin, data.radius, data.playersToDamage);
	let damageMultiplier = 1;

	// Cycle through all the nearby entities and damage it appropriately based on its distance from the origin.
	for (let ent of nearEnts)
	{
		let entityPosition = Engine.QueryInterface(ent, IID_Position).GetPosition2D();
		if (data.shape == 'Circular') // circular effect with quadratic falloff in every direction
			damageMultiplier = 1 - data.origin.distanceToSquared(entityPosition) / (data.radius * data.radius);
		else if (data.shape == 'Linear') // linear effect with quadratic falloff in two directions (only used for certain missiles)
		{
			// Get position of entity relative to splash origin.
			let relativePos = entityPosition.sub(data.origin);

			// Get the position relative to the missile direction.
			let direction = Vector2D.from3D(data.direction);
			let parallelPos = relativePos.dot(direction);
			let perpPos = relativePos.cross(direction);

			// The width of linear splash is one fifth of the normal splash radius.
			let width = data.radius / 5;

			// Check that the unit is within the distance splash width of the line starting at the missile's
			// landing point which extends in the direction of the missile for length splash radius.
			if (parallelPos >= 0 && Math.abs(perpPos) < width) // If in radius, quadratic falloff in both directions
				damageMultiplier = (1 - parallelPos * parallelPos / (data.radius * data.radius)) *
					(1 - perpPos * perpPos / (width * width));
			else
				damageMultiplier = 0;
		}
		else // In case someone calls this function with an invalid shape.
		{
			warn("The " + data.shape + " splash damage shape is not implemented!");
		}

		if (data.splashBonus)
			damageMultiplier *= GetDamageBonus(ent, data.splashBonus);

		// Call CauseDamage which reduces the hitpoints, posts network command, plays sounds....
		this.CauseDamage({
			"strengths": data.strengths,
			"target": ent,
			"attacker": data.attacker,
			"multiplier": damageMultiplier,
			"type": data.type + ".Splash",
			"attackerOwner": data.attackerOwner,
			"fire": data.fire
		});
	}
};

/**
 * Causes damage on a given unit.
 * @param {Object} data - the data passed by the caller.
 * @param {Object} data.strengths - data in the form of { 'hack': number, 'pierce': number, 'crush': number }.
 * @param {number} data.target - the entity id of the target.
 * @param {number} data.attacker - the entity id og the attacker.
 * @param {number} data.multiplier - the damage multiplier.
 * @param {number} data.flank - flank direction
 * @param {string} data.type - the type of damage.
 * @param {number} data.attackerOwner - the player id of the attacker.
 */
Damage.prototype.CauseDamage = function(data)
{
	let cmpDamageReceiver = Engine.QueryInterface(data.target, IID_DamageReceiver);
	if (!cmpDamageReceiver)
		return;

	if (!data.flank)
		data.flank = 0;

	let charge = data.charge || 0;
	let crit = data.critDamage || 0;

	let fire = data.fire || 0;
	let mount = data.mount || 0;
	if (mount)
		warn("deal mount damage " + mount);
	let targetState = cmpDamageReceiver.TakeDamage(data.strengths, data.multiplier, data.flank, fire, charge, mount, crit);

	let cmpExperience = Engine.QueryInterface(data.attacker, IID_Experience);
	let cmpLoot = Engine.QueryInterface(data.target, IID_Loot);
	let cmpHealth = Engine.QueryInterface(data.target, IID_Health);
	
	if (cmpLoot && cmpLoot.GetXp() > 0) {
		let amount = cmpLoot.GetXp() * -targetState.change / cmpHealth.GetMaxHitpoints();
			
		if (cmpExperience && !cmpExperience.IsMaxLeveled())
			cmpExperience.IncreaseXp(amount);
		
		let cmpUnitAI = Engine.QueryInterface(data.attacker, IID_UnitAI);
		if (cmpUnitAI && cmpUnitAI.IsFormationMember()) {
			let formationEnt = cmpUnitAI.GetFormationController();
			let cmpFormation = Engine.QueryInterface(formationEnt, IID_Formation);
			if (cmpFormation) {
				cmpFormation.DistributeExp(amount*0.5);
			}
		}
	}
	if (targetState.killed) {
		this.TargetKilled(data.attacker, data.target, data.attackerOwner);
	}

	let dmg = 0;
	if (!!targetState.change)
		dmg = targetState.change;
	Engine.PostMessage(data.target, MT_Attacked, { "attacker": data.attacker, "target": data.target, "type": data.type, "damage": -dmg, "attackerOwner": data.attackerOwner });
};

/**
 * Gets entities near a give point for given players.
 * @param {Vector2D} origin - the point to check around.
 * @param {number}   radius - the radius around the point to check.
 * @param {number[]} players - the players of which we need to check entities.
 * @return {number[]} - the id's of the entities in range of the given point.
 */
Damage.prototype.EntitiesNearPoint = function(origin, radius, players)
{
	// If there is insufficient data return an empty array.
	if (!origin || !radius || !players)
		return [];

	return Engine.QueryInterface(SYSTEM_ENTITY, IID_RangeManager).ExecuteQueryAroundPos(origin, 0, radius, players, IID_DamageReceiver);
};

/**
 * Called when a unit kills something (another unit, building, animal etc)
 * @param {number} attacker - the entity id of the killer.
 * @param {number} target - the entity id of the target.
 * @param {number} attackerOwner - the player id of the attacker.
 */
Damage.prototype.TargetKilled = function(attacker, target, attackerOwner)
{
	let cmpAttackerOwnership = Engine.QueryInterface(attacker, IID_Ownership);
	let atkOwner = cmpAttackerOwnership && cmpAttackerOwnership.GetOwner() != INVALID_PLAYER ? cmpAttackerOwnership.GetOwner() : attackerOwner;

	// Add to killer statistics.
	let cmpKillerPlayerStatisticsTracker = QueryPlayerIDInterface(atkOwner, IID_StatisticsTracker);
	if (cmpKillerPlayerStatisticsTracker)
		cmpKillerPlayerStatisticsTracker.KilledEntity(target);
	
	let cmpKnowledeClass = Engine.QueryInterface(target, IID_KnowledgeClass);
	if (cmpKnowledeClass) {
		let cmpKnowledgeManager = QueryPlayerIDInterface(atkOwner, IID_KnowledgeManager);
		if (cmpKnowledgeManager)
			cmpKnowledgeManager.AddPoints("Kill", cmpKnowledeClass.GetClass(), 1);
	}
	// Add to loser statistics.
	let cmpTargetPlayerStatisticsTracker = QueryOwnerInterface(target, IID_StatisticsTracker);
	if (cmpTargetPlayerStatisticsTracker)
		cmpTargetPlayerStatisticsTracker.LostEntity(target);

	// If killer can collect loot, let's try to collect it.
	let cmpLooter = Engine.QueryInterface(attacker, IID_Looter);
	if (cmpLooter)
		cmpLooter.Collect(target);

	let cmpUnitAI = Engine.QueryInterface(attacker, IID_UnitAI);
	if (cmpUnitAI) {
		//cmpUnitAI.TargetDied(target);
		if (cmpUnitAI.IsFormationMember()) {
			let formationEnt = cmpUnitAI.GetFormationController();
			let cmpFormation = Engine.QueryInterface(formationEnt, IID_Formation);
			if (cmpFormation)
				cmpFormation.UnitKilled(target);
		}
	}
	
};

Engine.RegisterSystemComponentType(IID_Damage, "Damage", Damage);